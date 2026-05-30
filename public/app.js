let currentTab = 'gen-tab';
let selectedGalleryRefs = [];
let currentResultUrl = null;
let currentResultPrompt = null;

// Переменная для прерывания текущей активной генерации
let currentAbortController = null;

// Переменная для хранения параметров последней успешной генерации
let lastRequestParams = null;

// Кэш манифеста галереи
let galleryManifest = [];

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('proxy-url').value = localStorage.getItem('proxy_url') || '';
    document.getElementById('api-key').value = localStorage.getItem('api_key') || '';

    loadGallery();

    document.getElementById('param-size').addEventListener('change', (e) => {
        const container = document.getElementById('custom-size-container');
        if (e.target.value === 'custom') {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    });
});

// Система Lightbox (Открытие изображения во весь экран)
function openLightbox(url) {
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    lightboxImg.src = url;
    lightbox.classList.remove('hidden');
}

function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    lightbox.classList.add('hidden');
    document.getElementById('lightbox-img').src = '';
}

// Система Toast-уведомлений
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `pointer-events-auto flex items-center gap-3 p-4 rounded-lg shadow-2xl border transition-all duration-300 transform translate-y-5 opacity-0 max-w-sm w-full`;

    let bg, border, text, icon;
    if (type === 'success') {
        bg = 'bg-[#142217]';
        border = 'border-[#22c55e]/30';
        text = 'text-[#4ade80]';
        icon = 'fa-circle-check';
    } else if (type === 'error') {
        bg = 'bg-[#2a1415]';
        border = 'border-[#ef4444]/30';
        text = 'text-[#f87171]';
        icon = 'fa-circle-exclamation';
    } else { // info
        bg = 'bg-[#131d35]';
        border = 'border-[#3b82f6]/30';
        text = 'text-[#60a5fa]';
        icon = 'fa-circle-info';
    }

    toast.className += ` ${bg} ${border} ${text}`;
    toast.innerHTML = `
        <i class="fa-solid ${icon} text-lg shrink-0"></i>
        <div class="text-xs font-semibold flex-1 leading-relaxed">${message}</div>
        <button onclick="this.parentElement.remove()" class="text-gray-400 hover:text-white transition ml-auto shrink-0"><i class="fa-solid fa-xmark"></i></button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.remove('translate-y-5', 'opacity-0');
    }, 10);

    setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-2');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 4000);
}

// Кастомное окно подтверждения
function showConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const text = document.getElementById('confirm-modal-text');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        text.innerText = message;
        modal.classList.remove('hidden');

        const cleanup = () => {
            modal.classList.add('hidden');
            okBtn.replaceWith(okBtn.cloneNode(true));
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        };

        document.getElementById('confirm-ok-btn').addEventListener('click', () => {
            cleanup();
            resolve(true);
        });

        document.getElementById('confirm-cancel-btn').addEventListener('click', () => {
            cleanup();
            resolve(false);
        });
    });
}

function toggleSettings() {
    const modal = document.getElementById('settings-modal');
    modal.classList.toggle('hidden');
}

function saveSettings() {
    const proxy = document.getElementById('proxy-url').value;
    const key = document.getElementById('api-key').value;
    localStorage.setItem('proxy_url', proxy);
    localStorage.setItem('api_key', key);
    toggleSettings();
    showToast('Настройки подключения успешно сохранены!', 'success');
}

function getSettingsHeaders() {
    return {
        'x-api-key': localStorage.getItem('api_key') || '',
        'x-proxy-url': localStorage.getItem('proxy_url') || ''
    };
}

// Обработчик ответов
async function handleResponse(res) {
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
        let errorMsg = 'Неизвестная ошибка сервера';

        if (data.error) {
            if (typeof data.error === 'object' && data.error !== null) {
                errorMsg = data.error.message || JSON.stringify(data.error);
            } else if (typeof data.error === 'string') {
                errorMsg = data.error;
            }
        } else if (data.message) {
            errorMsg = data.message;
        } else {
            errorMsg = `Ошибка HTTP со статусом: ${res.status}`;
        }

        throw new Error(errorMsg);
    }

    return data;
}

// Встроенный вывод ошибок
function showLocalError(msg) {
    const errorContainer = document.getElementById('error-container');
    const errorMessageText = document.getElementById('error-message-text');

    errorMessageText.innerText = msg;

    document.getElementById('no-result').classList.add('hidden');
    document.getElementById('result-container').classList.add('hidden');
    errorContainer.classList.remove('hidden');
}

// Функция управления состоянием генерации
function setGenerationState(isLoading) {
    const btnGen = document.getElementById('btn-generate');
    const btnEdit = document.getElementById('btn-edit');
    const loader = document.getElementById('loader');

    if (isLoading) {
        btnGen.disabled = true;
        btnEdit.disabled = true;
        btnGen.classList.add('opacity-50', 'cursor-not-allowed');
        btnEdit.classList.add('opacity-50', 'cursor-not-allowed');
        loader.classList.remove('hidden');
    } else {
        btnGen.disabled = false;
        btnEdit.disabled = false;
        btnGen.classList.remove('opacity-50', 'cursor-not-allowed');
        btnEdit.classList.remove('opacity-50', 'cursor-not-allowed');
        loader.classList.add('hidden');
    }
}

// Функция досрочной отмены генерации
function cancelActiveGeneration() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        showToast('Генерация отменена пользователем', 'info');
    }
}

// Переключение вкладок
function switchTab(tabId) {
    currentTab = tabId;
    const tabs = ['gen-tab', 'edit-tab', 'gallery-tab'];

    const globalParams = document.getElementById('global-params');
    const customSizeContainer = document.getElementById('custom-size-container');
    if (tabId === 'gallery-tab') {
        globalParams.classList.add('hidden');
        customSizeContainer.classList.add('hidden');
    } else {
        globalParams.classList.remove('hidden');
        if (document.getElementById('param-size').value === 'custom') {
            customSizeContainer.classList.remove('hidden');
        }
    }

    tabs.forEach(t => {
        const el = document.getElementById(t);
        const btn = document.getElementById(`btn-${t}`);
        if (t === tabId) {
            el.classList.remove('hidden');
            btn.classList.add('border-indigo-500', 'text-white');
            btn.classList.remove('border-transparent', 'text-gray-400');
        } else {
            el.classList.add('hidden');
            btn.classList.remove('border-indigo-500', 'text-white');
            btn.classList.add('border-transparent', 'text-gray-400');
        }
    });
}

// ГЕНЕРАЦИЯ (Text-to-Image)
async function generateImage() {
    const prompt = document.getElementById('gen-prompt').value;
    let size = document.getElementById('param-size').value;
    if (size === 'custom') {
        size = document.getElementById('custom-size').value;
    }
    const quality = document.getElementById('param-quality').value;
    const format = document.getElementById('param-format').value;
    const background = document.getElementById('param-background').value;
    const moderation = document.getElementById('param-moderation').value;
    const n = document.getElementById('param-n').value;

    if (!prompt.trim()) {
        showLocalError('Вы забыли ввести промпт для генерации!');
        return;
    }

    document.getElementById('error-container').classList.add('hidden');
    document.getElementById('result-container').classList.add('hidden');
    document.getElementById('no-result').classList.add('hidden');

    setGenerationState(true);

    currentAbortController = new AbortController();

    lastRequestParams = {
        prompt,
        size,
        quality,
        output_format: format,
        background,
        moderation,
        n: parseInt(n),
        isEditMode: false
    };

    try {
        const res = await fetch('/api/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getSettingsHeaders()
            },
            body: JSON.stringify({ prompt, size, quality, output_format: format, background, moderation, n }),
            signal: currentAbortController.signal
        });

        const data = await handleResponse(res);
        const urls = data.data.map(item => item.url);

        displayResults(urls, prompt);

        // Автоматически обновляем вкладку галереи новыми генерациями
        loadGallery();
        showToast('Изображение успешно создано и сохранено в галерею!', 'success');
    } catch (err) {
        if (err.name === 'AbortError') {
            document.getElementById('no-result').classList.remove('hidden');
        } else {
            showLocalError(err.message);
        }
    } finally {
        setGenerationState(false);
        currentAbortController = null;
    }
}

// РЕДАКТИРОВАНИЕ (Edit с поддержкой выбора качества)
async function editImage() {
    const prompt = document.getElementById('edit-prompt').value;
    let size = document.getElementById('param-size').value;
    if (size === 'custom') {
        size = document.getElementById('custom-size').value;
    }
    const moderation = document.getElementById('param-moderation').value;
    const n = document.getElementById('param-n').value;
    const quality = document.getElementById('edit-param-quality').value; // Чтение качества

    const imageInput = document.getElementById('edit-image');

    const localFilesCount = imageInput.files.length;
    const galleryFilesCount = selectedGalleryRefs.length;

    if (!prompt.trim()) {
        showLocalError('Введите описание изменений (промпт) в поле Edit!');
        return;
    }
    if (localFilesCount === 0 && galleryFilesCount === 0) {
        showLocalError('Для Edit mode необходимо прикрепить референс (или выбрать из галереи ниже)');
        return;
    }
    if (localFilesCount + galleryFilesCount > 16) {
        showToast('gpt-image-2 поддерживает не более 16 референсных изображений одновременно.', 'error');
        return;
    }

    document.getElementById('error-container').classList.add('hidden');
    document.getElementById('result-container').classList.add('hidden');
    document.getElementById('no-result').classList.add('hidden');

    setGenerationState(true);

    currentAbortController = new AbortController();

    lastRequestParams = {
        prompt,
        size,
        quality, // Запоминаем качество
        moderation,
        n: parseInt(n),
        isEditMode: true
    };

    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('size', size);
    formData.append('quality', quality); // Отправляем качество
    formData.append('moderation', moderation);
    formData.append('n', n);

    for (let i = 0; i < imageInput.files.length; i++) {
        formData.append('image', imageInput.files[i]);
    }

    if (galleryFilesCount > 0) {
        formData.append('savedImageRefs', JSON.stringify(selectedGalleryRefs));
    }

    try {
        const res = await fetch('/api/edit', {
            method: 'POST',
            headers: {
                ...getSettingsHeaders()
            },
            body: formData,
            signal: currentAbortController.signal
        });

        const data = await handleResponse(res);
        const urls = data.data.map(item => item.url);

        displayResults(urls, prompt);

        // Автоматически обновляем галерею
        loadGallery();
        showToast('Изображение отредактировано и сохранено в галерею!', 'success');
    } catch (err) {
        if (err.name === 'AbortError') {
            document.getElementById('no-result').classList.remove('hidden');
        } else {
            showLocalError(err.message);
        }
    } finally {
        setGenerationState(false);
        currentAbortController = null;
    }
}

// Отображение сетки результатов
// Кнопка сохранения заменена на инфо-бейдж «В галерее», так как файлы сохраняются автоматически
function displayResults(urls, prompt) {
    const grid = document.getElementById('result-images-grid');
    grid.innerHTML = '';

    if (urls.length === 1) {
        grid.className = 'grid grid-cols-1 gap-4 w-full justify-items-center max-w-lg mx-auto';
    } else {
        grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4 w-full';
    }

    urls.forEach((url, index) => {
        const item = document.createElement('div');
        item.className = 'card p-3 rounded-lg flex flex-col gap-3 border border-[#30363d] bg-[#161b22] relative group';

        item.innerHTML = `
            <div class="relative rounded overflow-hidden max-h-[350px] bg-black flex justify-center items-center group/img cursor-zoom-in">
                <img src="${url}" class="max-h-[350px] object-contain w-full select-none">
                <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition flex items-center justify-center">
                    <i class="fa-solid fa-magnifying-glass-plus text-white text-3xl"></i>
                </div>
            </div>
            <div class="flex gap-2 justify-between items-center text-xs">
                <span class="text-gray-400 font-semibold">Вариант ${index + 1}</span>
                <div class="flex gap-1.5">
                    <button class="expand-img-btn bg-zinc-800 hover:bg-zinc-700 text-white px-2.5 py-1 rounded font-bold transition flex items-center" title="Увеличить в текущем окне">
                        <i class="fa-solid fa-expand"></i>
                    </button>
                    <div class="bg-emerald-950/40 border border-emerald-800 text-emerald-400 px-2.5 py-1 rounded font-bold flex items-center gap-1 cursor-default select-none" title="Изображение автоматически сохранено в галерею">
                        <i class="fa-solid fa-cloud-arrow-down"></i> В галерее
                    </div>
                    <a href="${url}" target="_blank" download="gpt_image_${index + 1}.png" class="bg-zinc-800 hover:bg-zinc-700 text-white px-2.5 py-1 rounded font-bold transition flex items-center gap-1">
                        <i class="fa-solid fa-download"></i> Скачать
                    </a>
                </div>
            </div>
        `;

        item.querySelector('.cursor-zoom-in').addEventListener('click', () => {
            openLightbox(url);
        });

        item.querySelector('.expand-img-btn').addEventListener('click', () => {
            openLightbox(url);
        });

        grid.appendChild(item);
    });

    document.getElementById('no-result').classList.add('hidden');
    document.getElementById('error-container').classList.add('hidden');
    document.getElementById('result-container').classList.remove('hidden');
}

// Ручное сохранение конкретного изображения (оставлено для совместимости)
async function saveSpecificImage(url, prompt, btnElement) {
    btnElement.disabled = true;
    const originalHTML = btnElement.innerHTML;
    btnElement.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Сохранение...`;
    btnElement.classList.add('opacity-50');

    try {
        const res = await fetch('/api/save-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageUrl: url,
                prompt: prompt,
                params: lastRequestParams
            })
        });
        await handleResponse(res);

        btnElement.innerHTML = `<i class="fa-solid fa-check text-green-400"></i> Сохранено!`;
        showToast('Изображение добавлено в галерею!', 'success');
        loadGallery();
    } catch (err) {
        showToast('Ошибка сохранения:\n' + err.message, 'error');
        btnElement.innerHTML = originalHTML;
        btnElement.disabled = false;
        btnElement.classList.remove('opacity-50');
    }
}

// Загрузка галереи
function loadGallery() {
    fetch('/api/gallery')
        .then(res => res.json())
        .then(data => {
            galleryManifest = data;

            const counter = document.getElementById('gallery-counter');
            if (counter) {
                counter.innerText = `Всего: ${galleryManifest.length}`;
            }

            const container = document.getElementById('gallery');
            container.innerHTML = '';

            if (galleryManifest.length === 0) {
                container.innerHTML = '<p class="text-xs text-gray-500 col-span-full text-center py-4">Галерея пуста</p>';
                return;
            }

            galleryManifest.forEach(item => {
                const card = document.createElement('div');
                card.className = 'group relative rounded overflow-hidden border border-[#30363d] bg-black h-28 flex items-center justify-center';
                card.innerHTML = `
                    <img src="/saved_images/${item.filename}" class="object-cover h-full w-full opacity-80 group-hover:opacity-100 transition">
                    <div class="absolute inset-0 bg-black/85 opacity-0 group-hover:opacity-100 transition flex flex-col justify-between p-1.5 text-[9px]">
                        <span class="text-white truncate font-semibold" title="${item.prompt}">${item.prompt}</span>
                        <div class="grid grid-cols-2 gap-1 my-1">
                            <button onclick="restoreParams('${item.filename}')" class="bg-indigo-600 hover:bg-indigo-500 text-white py-1 rounded flex items-center justify-center gap-0.5" title="Применить промпт и параметры">
                                <i class="fa-solid fa-sliders"></i> Настройки
                            </button>
                            <button onclick="useAsReference('${item.filename}')" class="bg-emerald-600 hover:bg-emerald-500 text-white py-1 rounded flex items-center justify-center gap-0.5" title="Добавить как референс">
                                <i class="fa-solid fa-plus"></i> Реф.
                            </button>
                        </div>
                        <div class="flex justify-between items-center border-t border-[#30363d] pt-1">
                            <span class="text-gray-500 truncate" style="max-width: 60px;">${item.filename}</span>
                            <div class="flex gap-1.5">
                                <button class="gal-zoom-btn text-gray-400 hover:text-white" title="Увеличить">
                                    <i class="fa-solid fa-magnifying-glass-plus"></i>
                                </button>
                                <a href="/saved_images/${item.filename}" download class="text-gray-400 hover:text-white">
                                    <i class="fa-solid fa-download"></i>
                                </a>
                                <button onclick="deleteGalleryImage('${item.filename}')" class="text-red-500 hover:text-red-400">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                `;

                card.querySelector('.gal-zoom-btn').addEventListener('click', () => {
                    openLightbox(`/saved_images/${item.filename}`);
                });

                container.appendChild(card);
            });
        })
        .catch(err => console.error('Ошибка галереи:', err));
}

// Восстановление параметров генерации на основе кэшированной картинки
function restoreParams(filename) {
    const item = galleryManifest.find(i => i.filename === filename);
    if (!item) return;

    const params = item.params || { prompt: item.prompt, isEditMode: false };

    if (params.isEditMode) {
        switchTab('edit-tab');
        document.getElementById('edit-prompt').value = params.prompt || '';
        if (params.moderation) document.getElementById('param-moderation').value = params.moderation;
        if (params.n) document.getElementById('param-n').value = params.n;
        if (params.quality) document.getElementById('edit-param-quality').value = params.quality; // Восстановление качества редактирования

        const sizeVal = params.size || 'auto';
        handleSizeRestore(sizeVal);
    } else {
        switchTab('gen-tab');
        document.getElementById('gen-prompt').value = params.prompt || '';
        if (params.quality) document.getElementById('param-quality').value = params.quality;
        if (params.output_format) document.getElementById('param-format').value = params.output_format;
        if (params.background) document.getElementById('param-background').value = params.background;
        if (params.moderation) document.getElementById('param-moderation').value = params.moderation;
        if (params.n) document.getElementById('param-n').value = params.n;

        const sizeVal = params.size || 'auto';
        handleSizeRestore(sizeVal);
    }

    showToast(`Промпт и параметры "${filename}" успешно применены!`, 'info');
}

// Вспомогательная функция для выбора разрешения
function handleSizeRestore(sizeVal) {
    const sizeSelect = document.getElementById('param-size');
    const customContainer = document.getElementById('custom-size-container');
    const customInput = document.getElementById('custom-size');

    const standardSizes = ['auto', '1024x1024', '1536x864', '864x1536', '1024x768'];
    if (standardSizes.includes(sizeVal)) {
        sizeSelect.value = sizeVal;
        customContainer.classList.add('hidden');
    } else {
        sizeSelect.value = 'custom';
        customInput.value = sizeVal;
        customContainer.classList.remove('hidden');
    }
}

// Добавление в референсы
function useAsReference(filename) {
    if (!selectedGalleryRefs.includes(filename)) {
        if (selectedGalleryRefs.length >= 16) {
            showToast('Максимальное количество референсов — 16!', 'error');
            return;
        }
        selectedGalleryRefs.push(filename);
        showToast(`Картинка "${filename}" добавлена как референс.`, 'info');
    }
    document.getElementById('edit-image').value = '';
    updateGalleryRefsUI();
    switchTab('edit-tab');
}

function removeGalleryRef(filename) {
    selectedGalleryRefs = selectedGalleryRefs.filter(f => f !== filename);
    updateGalleryRefsUI();
}

function clearAllGalleryRefs() {
    selectedGalleryRefs = [];
    updateGalleryRefsUI();
    showToast('Все выбранные референсы очищены', 'info');
}

function updateGalleryRefsUI() {
    const display = document.getElementById('gallery-ref-display');
    const listContainer = document.getElementById('gallery-refs-list');

    if (selectedGalleryRefs.length === 0) {
        display.classList.add('hidden');
        listContainer.innerHTML = '';
        return;
    }

    display.classList.remove('hidden');
    listContainer.innerHTML = '';

    selectedGalleryRefs.forEach(filename => {
        const item = document.createElement('div');
        item.className = 'flex justify-between items-center text-xs text-indigo-200 bg-indigo-900/40 p-1.5 rounded border border-indigo-900';
        item.innerHTML = `
            <span class="truncate pr-2">${filename}</span>
            <button onclick="removeGalleryRef('${filename}')" class="text-red-400 hover:text-red-300 px-1"><i class="fa-solid fa-xmark"></i></button>
        `;
        listContainer.appendChild(item);
    });
}

// Удаление изображения из галереи
async function deleteGalleryImage(filename) {
    const confirmed = await showConfirm(`Вы действительно хотите безвозвратно удалить изображение "${filename}" с диска сервера?`);
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/gallery/${filename}`, { method: 'DELETE' });
        await handleResponse(res);
        removeGalleryRef(filename);
        loadGallery();
        showToast('Изображение успешно удалено.', 'success');
    } catch (err) {
        showToast('Ошибка при удалении:\n' + err.message, 'error');
    }
}
