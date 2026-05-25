@echo off
:: Переключаем кодировку консоли Windows на UTF-8
chcp 65001 > nul

title GPT-Image-2 Studio Launcher
echo ===================================================
echo  Запуск GPT-Image-2 Studio...
echo ===================================================
echo.
echo [1/2] Проверка установленных зависимостей...
if not exist node_modules (
    echo Папка node_modules не найдена. Устанавливаем зависимости...
    call npm install
)
echo [2/2] Запуск сервера и автоматическое открытие браузера...
start http://localhost:3000
node server.js
pause
