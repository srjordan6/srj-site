// The Operating System, the hero object of the relaunch.
//
// Everything is procedural, no model files: a warm emissive core, an inner
// ceramic ring carrying the four service nodes, a middle ring of nine navy
// glass volumes (the Library), and an outer hairline particle orbit. The
// treatment doc (§3) is the contract: 35mm feel, low camera looking up 4°,
// cursor parallax capped at 6° with 0.8s mass lag, scroll scrubs a push-in
// while the nine volumes align into a shelf, then the page docks the system
// as a mark beside the logo (handled in CSS by fading this canvas out).
import * as THREE from 'three';

const NAVY = 0x201868, NAVY_DEEP = 0x12103f, CREAM = 0xfff6ec, ORANGE = 0xf07800;

export function mountHero(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, -0.55, 8.4);
  camera.lookAt(0, 0.05, 0);

  // Lighting: warm key upper-left, orange rim behind, navy-tinted fill.
  scene.add(new THREE.AmbientLight(NAVY, 1.4));
  const key = new THREE.DirectionalLight(CREAM, 2.1); key.position.set(-4, 5, 6); scene.add(key);
  const rim = new THREE.PointLight(ORANGE, 14, 20, 2); rim.position.set(0.6, 0.4, -2.4); scene.add(rim);
  const fill = new THREE.DirectionalLight(0x6a5fd0, 0.5); fill.position.set(5, -2, 3); scene.add(fill);

  const system = new THREE.Group(); scene.add(system);

  // The core: one emissive orange body plus a sprite glow standing in for bloom.
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.52, 48, 48),
    new THREE.MeshStandardMaterial({ color: ORANGE, emissive: ORANGE, emissiveIntensity: 1.6, roughness: 0.35 })
  );
  system.add(core);
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(240,120,0,.55)'); grd.addColorStop(0.45, 'rgba(240,120,0,.16)'); grd.addColorStop(1, 'rgba(240,120,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
  })();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false }));
  glow.scale.setScalar(3.4); system.add(glow);

  const ceramic = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.55, metalness: 0.05 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: NAVY, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.92,
    clearcoat: 0.6, clearcoatRoughness: 0.4, emissive: NAVY_DEEP, emissiveIntensity: 0.35,
  });
  const glassWarm = glass.clone(); glassWarm.emissive = new THREE.Color(0x4a2a10); glassWarm.emissiveIntensity = 0.5;

  // Ring 1, ceramic, four service nodes. One revolution per 90s, clockwise.
  const ring1 = new THREE.Group(); system.add(ring1);
  ring1.add(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.022, 12, 128), ceramic));
  for (let i = 0; i < 4; i++) {
    const node = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), ceramic);
    const a = (i / 4) * Math.PI * 2;
    node.position.set(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5);
    ring1.add(node);
  }
  ring1.rotation.x = Math.PI / 2.35;

  // Ring 2, nine navy glass volumes, the Library. Books 1–5 glow warmer
  // (available), 6–9 stay cool (forthcoming). Counter-clockwise, 140s.
  const ring2 = new THREE.Group(); system.add(ring2);
  const volGeom = new THREE.BoxGeometry(0.16, 0.62, 0.44);
  const volumes = [];
  for (let i = 0; i < 9; i++) {
    const v = new THREE.Mesh(volGeom, i < 5 ? glassWarm : glass);
    const a = (i / 9) * Math.PI * 2;
    v.userData.angle = a;
    v.position.set(Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6);
    v.lookAt(0, 0, 0);
    ring2.add(v); volumes.push(v);
  }
  ring2.rotation.x = Math.PI / 2.5;

  // Ring 3, hairline particle orbit plus projector dust in the key light.
  const pts = [];
  for (let i = 0; i < 220; i++) {
    const a = Math.random() * Math.PI * 2, r = 3.4 + (Math.random() - 0.5) * 0.1;
    pts.push(Math.cos(a) * r, (Math.random() - 0.5) * 0.06, Math.sin(a) * r);
  }
  for (let i = 0; i < 320; i++) pts.push((Math.random() - 0.35) * 9, Math.random() * 6 - 2.5, (Math.random() - 0.5) * 4 - 1);
  const dust = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
    new THREE.PointsMaterial({ color: CREAM, size: 0.018, transparent: true, opacity: 0.5, depthWrite: false })
  );
  dust.rotation.x = Math.PI / 2.9; system.add(dust);

  // Entrance: core ignites, rings assemble, dust arrives last.
  const born = performance.now();
  core.scale.setScalar(0.001); glow.material.opacity = 0;
  ring1.scale.setScalar(0.7); ring2.scale.setScalar(0.7);
  ring1.visible = ring2.visible = dust.visible = false;

  // Cursor parallax: 6° max, eased with mass. Disabled under reduced motion.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tx = 0, ty = 0, cx = 0, cy = 0;
  if (!reduced) addEventListener('pointermove', (e) => {
    tx = (e.clientX / innerWidth - 0.5) * (Math.PI / 30);
    ty = (e.clientY / innerHeight - 0.5) * (Math.PI / 30);
  }, { passive: true });

  // Scroll scrub: 0 at top, 1 when the hero's travel is spent.
  let scroll = 0;
  const onScroll = () => { scroll = Math.min(1, Math.max(0, scrollY / (innerHeight * 1.1))); };
  addEventListener('scroll', onScroll, { passive: true });

  const clock = new THREE.Clock();
  let raf = 0, running = true;

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!running) return;
    const t = clock.getElapsedTime();
    const age = (performance.now() - born) / 1000;

    // Entrance beats.
    if (age < 2.6) {
      const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
      core.scale.setScalar(ease(age / 0.5));
      glow.material.opacity = ease(age / 0.7);
      if (age > 0.5) { ring1.visible = true; const k = ease((age - 0.5) / 0.8); ring1.scale.setScalar(0.7 + 0.3 * k); }
      if (age > 0.8) { ring2.visible = true; const k = ease((age - 0.8) / 0.9); ring2.scale.setScalar(0.7 + 0.3 * k); glass.opacity = glassWarm.opacity = 0.92 * k; }
      if (age > 1.6) { dust.visible = true; dust.material.opacity = 0.5 * ease((age - 1.6) / 0.9); }
    }

    // Idle life: breathing dolly, ring drift, core pulse.
    const breathe = reduced ? 0 : Math.sin(t / 3) * 0.08;
    ring1.rotation.z = t * (Math.PI * 2 / 90);
    ring2.rotation.z = -t * (Math.PI * 2 / 140);
    dust.rotation.y = t * 0.01;
    core.scale.setScalar(Math.min(1, core.scale.x) * (1 + Math.sin(t * 1.4) * 0.015));
    glow.scale.setScalar(3.4 + Math.sin(t * 1.4) * 0.12);

    // Scroll choreography: push in, flatten ring 2 toward a shelf, drift up.
    const s = reduced ? 0 : scroll;
    camera.position.z = 8.4 - breathe - s * 2.6;
    camera.position.y = -0.55 + s * 0.9;
    system.position.y = s * 0.4;
    ring2.rotation.x = Math.PI / 2.5 + s * (Math.PI / 2 - Math.PI / 2.5);
    volumes.forEach((v, i) => {
      const shelf = s > 0.55 ? (s - 0.55) / 0.45 : 0;
      const shelfX = (i - 4) * 0.5;
      v.position.x = THREE.MathUtils.lerp(Math.cos(v.userData.angle) * 2.6, shelfX, shelf);
      v.position.z = THREE.MathUtils.lerp(Math.sin(v.userData.angle) * 2.6, 0, shelf);
      if (shelf > 0) { v.rotation.set(0, (1 - shelf) * v.userData.angle, 0); } else v.lookAt(0, 0, 0);
    });

    // Cursor mass: eased toward target so the object moves like it weighs something.
    cx += (tx - cx) * 0.04; cy += (ty - cy) * 0.04;
    system.rotation.y = cx; system.rotation.x = cy * 0.7;

    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize(); addEventListener('resize', resize);
  new IntersectionObserver(([e]) => { running = e.isIntersecting; }, { threshold: 0 }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) running = false; });
  frame();
  return () => { cancelAnimationFrame(raf); renderer.dispose(); };
}
