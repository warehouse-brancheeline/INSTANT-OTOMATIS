# Jalankan sekali saja untuk membuat WEB INSTANT auto-start setiap Windows login
# dan otomatis restart kalau proses crash.
#
# Cara pakai: klik kanan file ini -> "Run with PowerShell" (dari folder project ini),
# atau buka terminal di folder project ini lalu jalankan: .\scripts\install-startup.ps1

npm install -g pm2 pm2-windows-startup

Set-Location $PSScriptRoot\..
pm2 start ecosystem.config.js
pm2 save
pm2-startup install

Write-Host ""
Write-Host "Selesai. WEB INSTANT akan otomatis jalan setiap kali login Windows."
Write-Host "Buka dashboard di: http://localhost:4123"
Write-Host "Lihat log: pm2 logs web-instant"
