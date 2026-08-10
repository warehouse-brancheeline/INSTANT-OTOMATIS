# Jalankan sekali saja supaya Print Agent ini otomatis jalan setiap kali laptop
# ini login Windows, dan otomatis restart kalau proses crash.
#
# Cara pakai: klik kanan file ini -> "Run with PowerShell" (dari folder ini),
# atau buka terminal di folder ini lalu jalankan: .\scripts\install-startup.ps1

npm install -g pm2 pm2-windows-startup

Set-Location $PSScriptRoot\..
pm2 start ecosystem.config.js
pm2 save
pm2-startup install

Write-Host ""
Write-Host "Selesai. Print Agent akan otomatis jalan setiap kali laptop ini login Windows."
Write-Host "Lihat log: pm2 logs web-instant-print-agent"
