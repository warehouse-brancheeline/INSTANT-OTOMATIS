# WEB INSTANT — Print Agent

Small standalone program that runs on an **additional** laptop (not the main
WEB INSTANT server) so its own connected printer also automatically prints
every resi/picklist, in addition to the main laptop's printer.

## Cara pasang (di laptop tambahan) — cara termudah

1. Di dashboard WEB INSTANT (di laptop utama), buka panel **Printer Cabang**,
   klik **Tambah Printer**, kasih nama (misal "Laptop Packing 2").
2. Klik **Download** di baris printer itu — dapat file zip yang sudah berisi
   `.env` terisi otomatis (alamat server + token), tidak perlu diisi manual.
3. Pindahkan zip itu ke laptop tambahan (flashdisk/WhatsApp/email/dsb), unzip.
4. Set printer default Windows di laptop itu ke printer yang mau dipakai.
5. Install [Node.js](https://nodejs.org) di laptop itu kalau belum ada.
6. Double-click `install.bat` — otomatis install lalu langsung jalan. Biarkan
   jendelanya tetap terbuka selama laptop dipakai untuk print otomatis.
7. (Opsional, supaya otomatis jalan tiap laptop dinyalakan) klik kanan
   `scripts\install-startup.ps1` → "Run with PowerShell".

## Cara pasang manual (kalau tidak lewat tombol Download)

Copy folder `print-agent` ini sendiri, `npm install`, lalu copy
`.env.example` jadi `.env` dan isi `SERVER_URL` (alamat dashboard WEB
INSTANT) serta `AGENT_TOKEN` (dari panel Printer Cabang) secara manual,
baru `npm start`.

## Cara kerja

Setiap kali laptop utama mencetak resi/picklist, salinan PDF yang sama
disiapkan untuk **setiap** printer cabang yang terdaftar (bukan dipilih per
lokasi — semua order dicetak duplikat di semua printer terdaftar). Program ini
mengecek server setiap beberapa detik, download PDF yang belum pernah dicetak
di laptop ini, lalu cetak ke printer default Windows di laptop ini.

## Hapus printer cabang

Di dashboard, panel **Printer Cabang** punya tombol hapus per baris. Setelah
dihapus, agent laptop itu akan berhenti menerima job baru (tokennya langsung
tidak valid).
