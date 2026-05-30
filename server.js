const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const logFilePath = path.join(__dirname, 'server.log');

// Нативная функция логирования
function logger(level, message, meta = null) {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | Meta: ${JSON.stringify(meta)}` : '';
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;

    let consoleColor = '\x1b[0m';
    switch (level.toLowerCase()) {
        case 'info': consoleColor = '\x1b[36m'; break;
        case 'success': consoleColor = '\x1b[32m'; break;
        case 'warn': consoleColor = '\x1b[33m'; break;
        case 'error': consoleColor = '\x1b[31m'; break;
    }

    const coloredLevel = `${consoleColor}[${level.toUpperCase()}]\x1b[0m`;
    console.log(`[${timestamp}] ${coloredLevel} ${message}`, meta ? meta : '');

    try {
        fs.appendFileSync(logFilePath, logLine, 'utf-8');
    } catch (err) {
        console.error('Ошибка записи лога в файл:', err.message);
    }
}

const uploadsDir = path.join(__dirname, 'uploads');
const savedImagesDir = path.join(__dirname, 'saved_images');
[uploadsDir, savedImagesDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger('info', `Создана рабочая директория: ${dir}`);
    }
});

const upload = multer({ dest: 'uploads/' });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static('public'));
app.use('/saved_images', express.static(savedImagesDir));

const getAuthHeaders = (req) => {
    const token = req.headers['x-api-key'] || process.env.OPENAI_API_KEY;
    let base = req.headers['x-proxy-url'] || process.env.PROXY_URL || 'https://api.openai.com/v1';

    // Нормализация прокси-URL для предотвращения 404 ошибок маршрутизации SDK
    base = base.replace(/\/$/, "");
    if (!base.endsWith('/v1') && !base.endsWith('/v3') && base.includes('openai.com')) {
        base += '/v1';
    }
    return { token, apiBase: base };
};

const getMimeType = (filename) => {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'application/octet-stream';
};

// Функция автоматического сохранения сгенерированного изображения на сервере
async function autoSaveImage(imageUrl, prompt, params) {
    let buffer;
    let ext = 'png';

    if (imageUrl.startsWith('data:image')) {
        const matches = imageUrl.match(/^data:image\/([A-Za-z+]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            throw new Error('Некорректный формат Data URI');
        }
        ext = matches[1];
        buffer = Buffer.from(matches[2], 'base64');
    } else {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Не удалось скачать картинку. Статус HTTP: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
        if (imageUrl.includes('.png')) ext = 'png';
        else if (imageUrl.includes('.webp')) ext = 'webp';
        else if (imageUrl.includes('.jpg') || imageUrl.includes('.jpeg')) ext = 'jpg';
    }

    // Рандомизатор имен файлов
    const filename = `img_${Date.now()}_${Math.floor(Math.random() *10000)}.${ext}`;
    const filepath = path.join(savedImagesDir, filename);

    fs.writeFileSync(filepath, buffer);

    const manifestPath = path.join(savedImagesDir, 'manifest.json');
    let manifest = [];
    if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }

    manifest.unshift({
        filename,
        prompt: prompt || 'Generated Image',
        timestamp: new Date().toISOString(),
        params: params || null
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return filename;
}

// ПРИЕМ И СОХРАНЕНИЕ КАСТОМНОГО GIF-ЛОАДЕРА НА СЕРВЕРЕ
app.post('/api/upload-loader', upload.single('loaderGif'), (req, res) => {
    if (!req.file) {
        logger('warn', 'Запрос на загрузку GIF отклонен: файл отсутствует');
        return res.status(400).json({ error: 'Пожалуйста, прикрепите файл GIF.' });
    }

    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    const targetPath = path.join(publicDir, 'custom_loader.gif');
    try {
        fs.renameSync(req.file.path, targetPath);
        logger('success', 'Кастомный GIF-лоадер успешно сохранен на сервере');
        res.json({ success: true, url: '/custom_loader.gif' });
    } catch (err) {
        logger('error', 'Ошибка при переносе кастомного GIF-лоадера:', err.message);
        res.status(500).json({ error: 'Не удалось сохранить файл на диске сервера: ' + err.message });
    }
});

app.get('/api/gallery', (req, res) => {
    const manifestPath = path.join(savedImagesDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        res.json(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
    } else {
        res.json([]);
    }
});

// ГЕНЕРАЦИЯ (Text-to-Image с автосохранением на диске сервера)
app.post('/api/generate', async (req, res) => {
    const { prompt, size, quality, output_format, background, moderation, n } = req.body;
    const { token, apiBase } = getAuthHeaders(req);

    logger('info', 'Запрос на генерацию изображения (Text-to-Image)', {
        prompt: prompt ? `${prompt.substring(0, 60)}...` : null,
        size, quality, output_format, background, moderation, n
    });

    if (!token) {
        logger('warn', 'Запрос отклонен: отсутствует API Ключ');
        return res.status(400).json({ error: 'Укажите API Ключ/Токен в настройках.' });
    }

    try {
        const openai = new OpenAI({
            apiKey: token,
            baseURL: apiBase
        });

        const payload = {
            model: 'gpt-image-2',
            prompt: prompt,
            size: size || '1024x1024',
            quality: quality || 'auto',
            response_format: 'url',
            background: background || 'auto',
            moderation: moderation || 'auto',
            n: parseInt(n) || 1,
            isEditMode: false // <--- ЯВНОЕ УКАЗАНИЕ РЕЖИМА ГЕНЕРАЦИИ ДЛЯ СОХРАНЕНИЯ ПАРАМЕТРОВ
        };

        logger('info', `Запуск генерации через OpenAI SDK...`);
        const response = await openai.images.generate(payload);

        if (!response || !response.data) {
            const apiErrorMsg = response?.error?.message || response?.error || JSON.stringify(response) || 'Пустой ответ прокси';
            throw new Error(`Прокси вернул ошибку: ${apiErrorMsg}`);
        }

        const normalizedData = [];
        for (const item of response.data) {
            const rawUrl = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
            try {
                const filename = await autoSaveImage(rawUrl, prompt, payload);
                normalizedData.push({ url: `/saved_images/${filename}` });
            } catch (saveErr) {
                logger('error', 'Ошибка автосохранения сгенерированного изображения', { error: saveErr.message });
                normalizedData.push({ url: rawUrl });
            }
        }

        logger('success', `Успешно сгенерировано и автоматически сохранено изображений: ${normalizedData.length}`);
        res.json({ data: normalizedData });
    } catch (error) {
        let errMsg = 'Неизвестная ошибка OpenAI SDK';
        let status = 500;

        if (error instanceof OpenAI.APIError) {
            status = error.status || 400;
            errMsg = error.error?.message || error.message;
        } else {
            errMsg = error.message;
        }

        logger('error', 'Ошибка при генерации изображения через SDK', { error: errMsg });
        res.status(status).json({ error: errMsg });
    }
});

// РЕДАКТИРОВАНИЕ (Image-to-Image с автосохранением на диске сервера)
app.post('/api/edit', upload.fields([
    { name: 'image', maxCount: 16 }
]), async (req, res) => {
    const { prompt, size, quality, moderation, savedImageRefs, n } = req.body;
    const { token, apiBase } = getAuthHeaders(req);

    const uploadedImages = req.files['image'] || [];

    let parsedSavedRefs = [];
    if (savedImageRefs) {
        try {
            parsedSavedRefs = JSON.parse(savedImageRefs);
        } catch (e) {
            logger('error', 'Ошибка парсинга savedImageRefs', { error: e.message });
        }
    }

    logger('info', 'Запрос на редактирование (Edit Mode)', {
        prompt: prompt ? `${prompt.substring(0, 60)}...` : null,
        size, quality, moderation, uploadedCount: uploadedImages.length, galleryCount: parsedSavedRefs.length, n
    });

    if (!token) {
        logger('warn', 'Запрос отклонен: отсутствует API Ключ');
        return res.status(400).json({ error: 'Укажите API Ключ/Токен в настройках.' });
    }

    if (uploadedImages.length === 0 && parsedSavedRefs.length === 0) {
        logger('warn', 'Запрос отклонен: не прикреплено ни одного референса');
        return res.status(400).json({ error: 'Необходимо прикрепить хотя бы одно референс-изображение.' });
    }

    const cleanupUploadedFiles = () => {
        uploadedImages.forEach(file => {
            if (fs.existsSync(file.path)) {
                try {
                    fs.unlinkSync(file.path);
                } catch (err) {
                    logger('error', 'Ошибка удаления временного файла:', err.message);
                }
            }
        });
    };

    try {
        const imageObjects = [];

        // Обработка загруженных файлов
        for (const file of uploadedImages) {
            const fileMime = file.mimetype || getMimeType(file.originalname);
            const base64Data = fs.readFileSync(file.path, { encoding: 'base64' });
            imageObjects.push({
                image_url: `data:${fileMime};base64,${base64Data}`
            });
            logger('info', `Подготовлен загруженный референс в Base64: ${file.originalname}`);
        }

        // Обработка файлов из галереи
        for (const filename of parsedSavedRefs) {
            const localPath = path.join(savedImagesDir, filename);
            if (fs.existsSync(localPath)) {
                const fileMime = getMimeType(filename);
                const base64Data = fs.readFileSync(localPath, { encoding: 'base64' });
                imageObjects.push({
                    image_url: `data:${fileMime};base64,${base64Data}`
                });
                logger('info', `Подготовлен референс из галереи в Base64: ${filename}`);
            }
        }

        cleanupUploadedFiles();

        const editPayload = {
            model: 'gpt-image-2',
            prompt: prompt,
            images: imageObjects,
            size: size || 'auto',
            quality: quality || 'auto',
            moderation: moderation || 'auto',
            n: parseInt(n) || 1,
            isEditMode: true // <--- ЯВНОЕ УКАЗАНИЕ РЕЖИМА РЕДАКТИРОВАНИЯ ДЛЯ СОХРАНЕНИЯ ПАРАМЕТРОВ
        };

        logger('info', `Отправка запроса на редактирование через прямой Fetch...`);
        const response = await fetch(`${apiBase}/images/edits`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(editPayload)
        });

        // ИСПРАВЛЕНА ОШИБКА ОТОБРАЖЕНИЯ ПУСТЫХ СКОБОК {}: Улучшен вывод ошибок прокси
        if (!response.ok) {
            let apiErrorMsg = '';
            try {
                const responseText = await response.text();
                try {
                    const errJson = JSON.parse(responseText);
                    apiErrorMsg = errJson?.error?.message || errJson?.error || JSON.stringify(errJson);
                } catch (jsonErr) {
                    apiErrorMsg = responseText || `Ошибка HTTP: ${response.status}`;
                }
            } catch (textErr) {
                apiErrorMsg = `Ошибка связи с прокси: HTTP статус ${response.status}`;
            }

            if (!apiErrorMsg || apiErrorMsg === '{}' || apiErrorMsg.trim() === '') {
                apiErrorMsg = `Ошибка HTTP статус ${response.status}`;
            }
            throw new Error(`Прокси вернул ошибку: ${apiErrorMsg}`);
        }

        const resJson = await response.json();

        if (!resJson || !resJson.data) {
            throw new Error('Прокси вернул пустой или некорректный ответ');
        }

        const normalizedData = [];
        for (const item of resJson.data) {
            const rawUrl = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
            try {
                const filename = await autoSaveImage(rawUrl, prompt, editPayload);
                normalizedData.push({ url: `/saved_images/${filename}` });
            } catch (saveErr) {
                logger('error', 'Ошибка автосохранения отредактированного изображения', { error: saveErr.message });
                normalizedData.push({ url: rawUrl });
            }
        }

        logger('success', `Изображение успешно отредактировано и сохранено. Вариантов: ${normalizedData.length}`);
        res.json({ data: normalizedData });
    } catch (error) {
        cleanupUploadedFiles();
        let errMsg = error.message || 'Неизвестная ошибка при редактировании';
        logger('error', 'Ошибка при редактировании через HTTP-запрос', { error: errMsg });
        res.status(500).json({ error: errMsg });
    }
});

// СОХРАНЕНИЕ
app.post('/api/save-image', async (req, res) => {
    const { imageUrl, prompt, params } = req.body;

    const safeUrlLog = imageUrl && imageUrl.startsWith('data:')
        ? `${imageUrl.substring(0, 80)}... [Base64 данных]`
        : imageUrl;

    logger('info', 'Запрос на ручное сохранение изображения (совместимость)', { imageUrl: safeUrlLog, hasParams: !!params });

    if (!imageUrl) {
        logger('warn', 'Сохранение отменено: отсутствует imageUrl');
        return res.status(400).json({ error: 'imageUrl обязателен.' });
    }

    try {
        const filename = await autoSaveImage(imageUrl, prompt, params);
        logger('success', `Изображение успешно сохранено вручную: ${filename}`);
        res.json({ success: true, filename });
    } catch (error) {
        logger('error', 'Ошибка при ручном сохранении на сервере', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// УДАЛЕНИЕ
app.delete('/api/gallery/:filename', (req, res) => {
    const { filename } = req.params;
    const filepath = path.join(savedImagesDir, filename);
    logger('info', `Запрос на удаление файла: ${filename}`);

    try {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

        const manifestPath = path.join(savedImagesDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            manifest = manifest.filter(item => item.filename !== filename);
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }

        logger('success', `Файл ${filename} успешно удален`);
        res.json({ success: true });
    } catch (error) {
        logger('error', `Ошибка при удалении файла ${filename}`, { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

const server = app.listen(PORT, () => {
    logger('success', `========================================================`);
    logger('success', ` СЕРВЕР ЗАПУЩЕН И ГОТОВ НА http://localhost:${PORT}`);
    logger('success', `========================================================`);
});

const cleanExit = () => {
    logger('info', 'Получен системный сигнал на завершение работы. Закрываем сервер...');
    server.close(() => {
        logger('success', 'Сервер успешно остановлен. Процесс выгружен.');
        process.exit(0);
    });
};

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('SIGHUP', cleanExit);
