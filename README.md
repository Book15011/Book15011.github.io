# ⚡🤖 Thanisorn J. — Dual-Track Portfolio

**Demo**

https://github.com/user-attachments/assets/9839607c-18e0-4c40-a833-4d936760924d

A personal portfolio split into two tracks from a single Gateway: an **interactive 3D robotics showcase** (Three.js + GSAP) and an **institutional-style quantitative finance portfolio**. Visitors pick their path on landing; recruiters from either world land on a page built for them.

## 🗺️ Site Map

- **`index.html`** — the Gateway. Split-screen chooser between the two tracks.
- **Quant Developer track** — `quant.html` (single scrolling page: hero, profile, skillset, projects, contact)
- **Robotics Engineer track** — `robotics.html` (the original interactive 3D robot experience, formerly `index.html`) → `about.html` → `projects.html` → `contact.html` → `thanks.html`

## ✨ Key Features

**Gateway**
- GSAP-driven split-screen with hover/focus expansion and a live canvas background per track (ticker + correlation network on the Quant side, node field + scanline on the Robotics side)

**Quant Developer**
- Canvas hero animation blending an oscilloscope-style trace with a live ticker line
- Scroll-triggered skill bars and tag reveals (GSAP ScrollTrigger)
- Project cards with hover-revealed performance stats

**Robotics Engineer**
- Interactive 3D robot model with cursor head-tracking (Three.js + GLTFLoader)
- Model switching, color-shift, and dance-mode effects
- Cyberpunk aesthetic with dynamic lighting and glitch-transition navigation

## 🛠 Technical Implementation

- **Three.js** + **GLTFLoader** for WebGL 3D rendering (Robotics track only)
- **GSAP** + **ScrollTrigger** for animation (Gateway and Quant track; Robotics track uses its own separately-loaded GSAP 3.8.0)
- **Web3Forms** for the serverless contact form
- **GitHub Pages** hosting
- **GLB robot models** loaded client-side (`robot_1.glb`–`robot_3.glb`)

## 🚀 Live Deployment

Access the live portfolio at:
[https://book15011.github.io](https://book15011.github.io)

## 📂 Project Structure
- index.html      # Gateway — choose Quant or Robotics
- quant.html      # Quantitative Developer portfolio (self-contained)
- robotics.html   # Interactive 3D robot homepage (formerly index.html)
- about.html      # Robotics track — professional background
- projects.html   # Robotics track — project showcase
- contact.html    # Robotics track — contact form
- thanks.html     # Robotics track — submission confirmation
- robot_1.glb, robot_2.glb, robot_3.glb   # 3D robot models
- style.css, script.js   # Legacy assets — not currently linked from any page

## 📝 Notes for next cleanup
- `robotics.html`'s model selector references a fourth model, `robot_4.glb` ("Heavy Bot"), which isn't in this repo — add the file or drop that entry from the `models` array.
- The contact email (`thanisornjarudilokkil@gmail.com`) and LinkedIn slug (`thanisorn-jarudilokkul`) spell the surname differently — worth confirming which is correct.
