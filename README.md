# ⚡🤖 Thanisorn J. — Dual-Track Portfolio

**Demo**

https://github.com/user-attachments/assets/9839607c-18e0-4c40-a833-4d936760924d

A personal portfolio split into two tracks from a single Gateway: a **Quantitative Strategist / Global Markets** portfolio and an **interactive 3D robotics showcase** (Three.js + GSAP). Visitors pick their path on landing; recruiters from either world land on a page built for them.

## 🗺️ Site Map

- **`index.html`** — the Gateway. Split-screen chooser between the two tracks.
- **Quant track** — `quant.html` (single scrolling page: hero, profile, skillset, projects, tracked exposure, contact)
- **Robotics track** — `robotics.html` (the original interactive 3D robot experience, formerly `index.html`) → `about.html` → `projects.html` → `contact.html` → `thanks.html`

## ✨ Key Features

**Gateway** — GSAP-driven split-screen with hover/focus expansion and a live canvas background per track.

**Quant track** (positioned for Quantitative Strategist / Global Markets Trading roles)
- Canvas hero animation blending an oscilloscope-style trace with a live ticker line
- Scroll-triggered skill bars and tag reveals (GSAP ScrollTrigger)
- Project cards for a completed C++ limit-order-book engine + RL execution agent, plus two clearly-marked *Concept*-stage projects (vol-surface pricer, microstructure/risk simulator)
- A **Tracked Exposure** section: an animated SVG donut chart + legend showing a paper book's allocation. Allocation is always manual (no public API can see a personal brokerage book); price/24h-change can optionally go live via a free Finnhub API key — see `FINNHUB_API_KEY` near the bottom of `quant.html`'s script. Empty key = static snapshot, page still looks complete.
- Cross-track nav pill to Robotics, colored in *that track's* accent as a wayfinding cue

**Robotics track**
- Interactive 3D robot model with cursor head-tracking (Three.js + GLTFLoader), model switching, color-shift, dance mode
- Typography refreshed to Inter / Roboto Mono (from the system font stack) to match the Quant track's type system, plus small HUD-style eyebrow/control labels — purely visual, the Three.js/GSAP engine underneath is untouched
- Cross-track nav pill to Quant, same wayfinding convention

## 🛠 Technical Implementation

- **Three.js** + **GLTFLoader** for WebGL 3D rendering (Robotics track only)
- **GSAP** + **ScrollTrigger** for animation (Gateway and Quant track; Robotics track keeps its own separately-loaded GSAP 3.8.0)
- **Finnhub** (optional, free tier) for live quotes on the Tracked Exposure chart
- **Web3Forms** for the serverless contact form
- **GitHub Pages** hosting
- **GLB robot models** loaded client-side (`robot_1.glb`–`robot_3.glb`)

## 🚀 Live Deployment

[https://book15011.github.io](https://book15011.github.io)

## 📂 Project Structure
- index.html      # Gateway — choose Quant or Robotics
- quant.html      # Quantitative Strategist portfolio (self-contained)
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
- The Tracked Exposure holdings/prices in `quant.html` are placeholder data — edit the `HOLDINGS` array near the bottom of the script to reflect a real (or intentionally illustrative) book.
