document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Cache DOM Elements ---
    const head = document.getElementById('robot-head');
    const pupils = document.querySelectorAll('.pupil');
    const body = document.body;

    // --- 2. State Variables ---
    // Target position (from real mouse)
    let targetPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    // Current animated position (eased for smoothness)
    let currentPos = { ...targetPos };
    // Easing factor for smooth movement
    const easeFactor = 0.08;

    let isGlitching = false;
    let glitchTimeout;

    // --- 3. Event Listeners ---
    document.addEventListener('mousemove', (e) => {
        targetPos.x = e.clientX;
        targetPos.y = e.clientY;
    });
    document.addEventListener('click', () => {
        if (isGlitching) return; // Prevent re-triggering while glitching

        isGlitching = true;
        // Add a random color flash to the glitch
        head.style.filter = `hue-rotate(${Math.random() * 360}deg)`;

        clearTimeout(glitchTimeout);
        glitchTimeout = setTimeout(() => {
            isGlitching = false;
            head.style.filter = 'none';
        }, 300); // Glitch duration
    });

    // --- 4. Animation Loop (The Core) ---
    function animate() {
        // Use easing (linear interpolation) to smoothly move the current position towards the target
        currentPos.x += (targetPos.x - currentPos.x) * easeFactor;
        currentPos.y += (targetPos.y - currentPos.y) * easeFactor;

        // Normalize position (value from 0 to 1) for calculations
        const normX = currentPos.x / window.innerWidth;
        const normY = currentPos.y / window.innerHeight;

        // --- Head Movement ---
        const headRotateX = (normY - 0.5) * 30; // Rotate up/down based on mouse Y
        const headRotateY = (normX - 0.5) * 40; // Rotate left/right based on mouse X
        const headHoverY = Math.sin(Date.now() / 600) * 10; // Continuous floating effect

        let headTransform = `
            perspective(1000px) 
            translateY(${headHoverY}px) 
            rotateX(${headRotateX}deg) 
            rotateY(${headRotateY}deg)
        `;

        // --- Glitch Effect on Click ---
        if (isGlitching) {
            const glitchX = (Math.random() - 0.5) * 15;
            const glitchY = (Math.random() - 0.5) * 15;
            const glitchSkew = (Math.random() - 0.5) * 10;
            headTransform += ` translateX(${glitchX}px) translateY(${glitchY}px) skew(${glitchSkew}deg)`;
        }
        head.style.transform = headTransform;

        // --- Pupil Movement (more exaggerated) ---
        const pupilMoveX = (normX - 0.5) * 35;
        const pupilMoveY = (normY - 0.5) * 25;
        pupils.forEach(pupil => {
            pupil.style.transform = `translate(${pupilMoveX}px, ${pupilMoveY}px)`;
        });

        // --- Background Color Shift (now smoother) ---
        const hue = normX * 360;
        body.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 15%), hsl(${hue + 60}, 70%, 25%), hsl(${hue + 120}, 70%, 15%))`;

        // Request the next frame to create the loop
        requestAnimationFrame(animate);
    }

    // Start the animation loop
    animate();
});