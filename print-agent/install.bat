@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   WEB INSTANT - Print Agent - Instalasi
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terinstall di laptop ini.
  echo Silakan install dulu dari https://nodejs.org lalu jalankan install.bat ini lagi.
  pause
  exit /b 1
)

echo Menginstall dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo GAGAL menginstall dependencies.
  pause
  exit /b 1
)

echo.
echo Instalasi selesai. Menjalankan Print Agent sekarang...
echo (Biarkan jendela ini terbuka selama laptop ini dipakai untuk print otomatis.
echo  Untuk auto-start setiap login Windows, jalankan scripts\install-startup.ps1)
echo.
call npm start
pause
