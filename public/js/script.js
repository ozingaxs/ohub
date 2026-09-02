import * as THREE from '//cdn.skypack.dev/three@0.130.0?min'
import { gsap } from '//cdn.skypack.dev/gsap@3.7.0?min'

const imgUrl = 'https://images.unsplash.com/photo-1613721880907-77b1bb086164?ixlib=rb-1.2.1&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=634&q=80'
const imgRatio = 634 / 951;
const targetCameraZ = 180;
const instanceSize = 1;
const randRangeZ = 2 * (targetCameraZ) * .99; // spread *.5 +-
const initCamaraZ = targetCameraZ / 5;

// ----
// main
// ----

const renderer = new THREE.WebGLRenderer({ alpha: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 2, .5, 1000);
camera.position.set(0, 0, initCamaraZ);

function f(x, y, targetZ) {
  const h = 0.5; // half h
  const d = targetCameraZ;
  const D = -targetZ + d;
  const H = h / d * D;
  const s = H / h;
  return { s, p: new THREE.Vector3(x * s, y * s, targetZ) };
}

const mesh = (() => {
  const nRow = 256;
  const nCol = nRow * imgRatio | 0;
  const sz = instanceSize;

  const geom = new THREE.BoxGeometry(sz, sz, sz).translate(0, 0, -.5 * sz);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geom, mat, nCol * nRow);

  for (let i = 0, c = 0; i < nRow; ++i) {
    for (let j = 0; j < nCol; ++j) {
      const { p, s } = f(
        (j - nCol / 2 + .5) * sz,
        (nRow / 2 - i + .5) * sz,
        THREE.MathUtils.randFloatSpread(randRangeZ) * sz);
      const m = new THREE.Matrix4().setPosition(p)
        .multiply(new THREE.Matrix4().makeScale(s, s, s));
      mesh.setMatrixAt(c, m);
      mesh.setColorAt(c, new THREE.Color('white'));
      ++c;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
})();
scene.add(mesh);

{
  const img = new Image();
  img.onload = () => {
    const { width, height } = img;
    const can = document.createElement('canvas');
    can.height = 256;
    can.width = can.height * imgRatio | 0;
    const ctx = can.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height, 0, 0, can.width, can.height,);
    const { data } = ctx.getImageData(0, 0, can.width, can.height);
    const c = new THREE.Color();
    const total = data.length >> 2;
    for (let i = 0; i < total; ++i) {
      mesh.setColorAt(i, c.setRGB(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255));
    }
    mesh.instanceColor.needsUpdate = true;
  }
  img.crossOrigin = '';
  img.src = imgUrl;
}

// ----
// render
// ----

renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
});

// ----
// view
// ----

function resize(w, h, dpr = devicePixelRatio) {
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', () => resize(innerWidth, innerHeight));
dispatchEvent(new Event('resize'));
document.body.prepend(renderer.domElement);

// ----
// scroll
// ----

function setCamPos() {
  const H = document.documentElement.offsetHeight - window.innerHeight;
  const r = window.scrollY / H; // ratio
  const z = initCamaraZ + (targetCameraZ - initCamaraZ) * r;
  gsap.killTweensOf(camera.position);
  gsap.to(camera.position, { z });
}
document.addEventListener('scroll', setCamPos);