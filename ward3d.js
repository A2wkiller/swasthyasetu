/* SwasthyaSetu 3D: three.js ward (primitives) + anatomy body viewer (Z-Anatomy-derived body.glb, CC-BY-SA 4.0 - see NOTICE).
   No network calls; everything loads from vendor/. */
"use strict";

/* ================= WARD ================= */
window.Ward3D = (() => {
  let scene, camera, renderer, controls, beds = {}, patients = [], selectedId = null, onPick = null, running = false;
  const STATUS_COLORS = { stable: 0x4ade80, review: 0xfbbf24, critical: 0xef4444 };
  const MATTRESS = { stable: 0xeafaf1, review: 0xfef3c7, critical: 0xfee2e2 };

  function textSprite(text) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 80;
    const g = c.getContext("2d");
    g.fillStyle = "rgba(255,255,255,0.92)"; g.roundRect ? (g.beginPath(), g.roundRect(28, 12, 200, 56, 14), g.fill()) : g.fillRect(28, 12, 200, 56);
    g.fillStyle = "#0f766e"; g.font = "bold 40px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 128, 42);
    const t = new THREE.CanvasTexture(c);
    const m = new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true });
    const s = new THREE.Sprite(m); s.scale.set(1.5, 0.47, 1); return s;
  }

  function makeBed(p) {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.22, 1.3), new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.8 }));
    frame.position.y = 0.45; frame.castShadow = true; g.add(frame);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.8, 1.3), new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.8 }));
    head.position.set(-1.32, 0.85, 0); head.castShadow = true; g.add(head);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.4, 1.05), new THREE.MeshStandardMaterial({ color: 0x9aa5a1 }));
    legs.position.y = 0.2; g.add(legs);
    const mattress = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.18, 1.12), new THREE.MeshStandardMaterial({ color: MATTRESS.stable, roughness: 0.6 }));
    mattress.position.y = 0.65; mattress.castShadow = true; mattress.userData.pid = p.id; g.add(mattress);
    const bodyMat = new THREE.MeshStandardMaterial({ color: STATUS_COLORS.stable, roughness: 0.45, emissive: 0x000000 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.55, 18), bodyMat);
    body.rotation.z = Math.PI / 2; body.position.set(-0.1, 0.9, 0); body.castShadow = true; body.userData.pid = p.id; g.add(body);
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 14), new THREE.MeshStandardMaterial({ color: 0xf2c9a0, roughness: 0.7 }));
    headM.position.set(-0.95, 0.92, 0); headM.castShadow = true; headM.userData.pid = p.id; g.add(headM);
    const alarm = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.9 }));
    alarm.position.set(-1.32, 1.5, 0); alarm.visible = false; g.add(alarm);
    const label = textSprite(p.bed); label.position.set(0, 1.9, 0); g.add(label);
    g.position.set(p.xy3[0], 0, p.xy3[1]);
    scene.add(g);
    return { group: g, mattress, body, bodyMat, alarm, baseY: 0.9 };
  }

  function init(canvas, patientData, pickCb) {
    patients = patientData; onPick = pickCb;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 2, 0.1, 100);
    camera.position.set(7.5, 6.5, 7.5);
    controls = new THREE.OrbitControls(camera, canvas);
    controls.target.set(0, 0.6, 0); controls.enableDamping = true; controls.dampingFactor = 0.06;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.55;
    controls.maxPolarAngle = Math.PI / 2.15; controls.minDistance = 4; controls.maxDistance = 18;
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xfff7e8, 0.9);
    sun.position.set(6, 10, 4); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -8; sun.shadow.camera.right = 8; sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.25, 7.5), new THREE.MeshStandardMaterial({ color: 0xc9e2da, roughness: 0.95 }));
    floor.position.y = -0.13; floor.receiveShadow = true; scene.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe4f1ec, roughness: 1 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(12.5, 2.6, 0.2), wallMat); back.position.set(0, 1.15, -3.75); scene.add(back);
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, 7.5), wallMat); left.position.set(-6.25, 1.15, 0); scene.add(left);
    for (const p of patients) beds[p.id] = makeBed(p);
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    canvas.addEventListener("pointerdown", e => {
      const r = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1; mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      const hits = ray.intersectObjects(scene.children, true).filter(h => h.object.userData.pid);
      if (hits.length && onPick) onPick(hits[0].object.userData.pid);
    });
    running = true; animate();
  }

  let t = 0;
  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    t += 0.016;
    for (const p of patients) {
      const b = beds[p.id]; if (!b) continue;
      b.body.scale.y = 1 + Math.sin(t * 2.2 + p.xy3[0]) * 0.07; // breathing
      if (b.alarm.visible) b.alarm.scale.setScalar(1 + Math.sin(t * 6) * 0.35);
    }
    const canvas = renderer.domElement, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    controls.update(); renderer.render(scene, camera);
  }

  function sync(patientData, selId) {
    patients = patientData; selectedId = selId;
    for (const p of patients) {
      const b = beds[p.id]; if (!b) continue;
      const st = p.hr > 110 || p.spo2 < 92 ? "critical" : p.hr > 100 || p.spo2 < 95 || p.sys > 140 ? "review" : "stable";
      b.bodyMat.color.setHex(STATUS_COLORS[st]);
      b.bodyMat.emissive.setHex(st === "critical" ? 0x7f1d1d : 0x000000);
      b.mattress.material.color.setHex(MATTRESS[st]);
      b.alarm.visible = st !== "stable";
      b.group.children.forEach(m => { if (m.material && m !== b.alarm) m.material.opacity = 1; });
      b.group.traverse(o => { if (o.isMesh) { o.material.transparent = true; o.material.opacity = (p.id === selectedId || !selectedId) ? 1 : 0.45; } });
    }
  }
  return { init, sync };
})();

/* ================= ANATOMY BODY (Z-Anatomy derived, CC-BY-SA 4.0 - see NOTICE) ================= */
window.BodyView = (() => {
  let scene, camera, renderer, model, beatLight, beatMarker, hr = 80, ready = false, failed = false, t = 0;
  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(2, 4, 3); scene.add(key);
    beatLight = new THREE.PointLight(0xef4444, 0.9, 1.6); scene.add(beatLight);
    beatMarker = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 10), new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444 }));
    scene.add(beatMarker);
    const draco = new THREE.DRACOLoader(); draco.setDecoderPath("vendor/draco/");
    const loader = new THREE.GLTFLoader(); loader.setDRACOLoader(draco);
    const timeout = setTimeout(() => { if (!ready) failed = true; }, 9000);
    loader.load("vendor/body.glb", gltf => {
      clearTimeout(timeout);
      model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      const s = 1.7 / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(s);
      box.setFromObject(model); box.getCenter(center);
      model.position.sub(center);
      const mat = new THREE.MeshStandardMaterial({ color: 0xd9907a, roughness: 0.65, metalness: 0.05 });
      model.traverse(o => { if (o.isMesh) o.material = mat; });
      scene.add(model);
      const h = box.max.y - box.min.y;
      beatLight.position.set(0, h * 0.12, 0.35); beatMarker.position.set(0, h * 0.12, 0.16);
      camera.position.set(0, h * 0.1, 1.45); camera.lookAt(0, h * 0.05, 0);
      ready = true;
    }, undefined, () => { clearTimeout(timeout); failed = true; });
    animate();
  }
  function animate() {
    requestAnimationFrame(animate);
    t += 0.016;
    const canvas = renderer.domElement, w = canvas.clientWidth || 260, hgt = canvas.clientHeight || 320;
    if (canvas.width !== w * renderer.getPixelRatio()) { renderer.setSize(w, hgt, false); camera.aspect = w / hgt; camera.updateProjectionMatrix(); }
    if (model) {
      model.rotation.y += 0.006;
      const beat = 60 / Math.max(40, hr), phase = (t % beat) / beat;
      const pulse = phase < 0.12 ? 1 + phase * 3 : phase < 0.24 ? 1.36 - (phase - 0.12) * 2.8 : 1;
      beatMarker.scale.setScalar(pulse * 1.6); beatLight.intensity = 0.5 + pulse * 0.9;
    }
    renderer.render(scene, camera);
  }
  return { init, setHR: v => { hr = v; }, isReady: () => ready, hasFailed: () => failed };
})();
