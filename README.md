# Piano 88

Piano web dengan **88 tuts penuh (A0–C8)**, tanpa framework, tanpa build step.

## Jalankan

```powershell
node server.js
```

Lalu buka <http://localhost:5178>.

> Harus lewat server, bukan double-click `index.html`. Browsers memblokir `fetch()` file lokal (CORS), jadi sample tidak akan termuat kalau dibuka langsung.

## Kontrol

| Aksi | Cara |
| --- | --- |
| Mainkan tuts | Klik / sentuh, atau seret melintasi tuts (glissando) |
| Velocity | Klik makin ke bawah tuts = makin keras |
| Sustain pedal | Tahan **Spasi**, atau tahan tombol **Sustain** (berguna di HP) |
| Keyboard komputer | Baris bawah `Z S X D C V G B H N J M` (satu oktaf kromatik) |
| | Baris atas `Q 2 W 3 E R 5 T 6 Y 7 U I` (oktaf di atasnya) |
| Ganti oktaf | **←** / **→** |
| Volume | Slider di kanan atas |

## Struktur

```
index.html      markup
styles.css      tampilan (keybed, felt, key hitam/putih)
app.js          audio engine + input + sustain
server.js       static server tanpa dependency (port 5178)
samples/*.mp3   15 titik sample (C1, A1, C2, A2 … C8)
```

## Audio

- Sample: **Salamander Grand Piano** (Yamaha C5), Alexander Holm — CC-BY 3.0.
- 15 titik nada, setiap tuts lain di-*pitch-shift* maksimal ±1,5 semitone, jadi kualitas tetap wajar.
- Rantai: buffer → lowpass (makin keras makin terang) → gain envelope → bus → compressor → low-shelf +3,5 dB @140 Hz → master.
- Reverb: impulse response dibuat di runtime (2,6 s noise decay), send 17%.

### Catatan soal Klavins Model 450

Klavins Model 450 tidak punya library sample publik — itu piano one-off 450 tuts, yang beredar hanya rekaman. Jadi nada di sini memakai Salamander Grand, dibentuk ke arah karakter Klavins (low-end dalam, decay panjang). Kalau ada rekaman Klavins yang mau dipakai, sample set-nya bisa diganti: taruh file di `samples/` dengan nama `C1.mp3 … C8.mp3`, lalu sesuaikan array `ANCHORS` di `app.js`.
