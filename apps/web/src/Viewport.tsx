// Вьюпорт three.js. Поза считается вживую ядром (poseAt) на каждом кадре — без запекания и AnimationMixer,
// поэтому правка параметра рецепта или ключа видна сразу.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { poseAt, type Clip, type Project, type Rig } from "../../../packages/core/src/index.ts";

interface Props {
  modelUrl: string;
  project: Project;
  rig: Rig;
  clip: Clip | undefined;
  t: number;
  selectedBone: string | null;
  showSkeleton: boolean;
  onStatus(msg: string, error?: boolean): void;
}

interface Loaded {
  root: THREE.Object3D;
  bones: Map<string, { obj: THREE.Object3D; rest: THREE.Quaternion }>;
  helper: THREE.SkeletonHelper;
  size: number;
}

export function Viewport(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  // всё, что меняется часто, читаем из ref внутри цикла отрисовки
  const live = useRef(props);
  live.current = props;
  const sceneRef = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls } | null>(null);
  const loaded = useRef<Loaded | null>(null);

  // сцена, камера, цикл отрисовки — один раз
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d2026);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(3, 5, 4);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    camera.position.set(2, 2, 3);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    sceneRef.current = { scene, camera, controls };

    // маркер выбранной кости: шарик в суставе и отрезок до дочерней кости, поверх меша
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb547, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.renderOrder = 10;
    const segGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const segment = new THREE.Line(segGeom, new THREE.LineBasicMaterial({ color: 0xffb547, depthTest: false }));
    segment.renderOrder = 10;
    scene.add(marker, segment);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = live.current;
      const m = loaded.current;
      if (m) {
        // поза из ядра; кости, которых нет в позе, возвращаем в rest
        const pose = p.clip ? poseAt(p.project, p.rig, p.clip, p.t) : new Map();
        for (const [name, { obj, rest }] of m.bones) {
          const q = pose.get(name);
          if (q) obj.quaternion.set(q[0], q[1], q[2], q[3]);
          else obj.quaternion.copy(rest);
        }
        m.root.updateMatrixWorld(true);
        m.helper.visible = p.showSkeleton;

        const sel = p.selectedBone ? m.bones.get(p.selectedBone) : undefined;
        marker.visible = segment.visible = !!sel;
        if (sel) {
          sel.obj.getWorldPosition(a);
          marker.position.copy(a);
          marker.scale.setScalar(m.size * 0.018);
          const child = sel.obj.children.find((c) => (c as THREE.Bone).isBone);
          if (child) child.getWorldPosition(b);
          else b.copy(a);
          segGeom.attributes.position.setXYZ(0, a.x, a.y, a.z);
          segGeom.attributes.position.setXYZ(1, b.x, b.y, b.z);
          segGeom.attributes.position.needsUpdate = true;
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  // модель: перезагружаем, только если сменился путь к glb
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    let cancelled = false;
    let grid: THREE.GridHelper | null = null;
    new GLTFLoader().load(
      props.modelUrl,
      (gltf) => {
        if (cancelled) return;
        const root = gltf.scene;
        root.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
        });
        const bones = new Map<string, { obj: THREE.Object3D; rest: THREE.Quaternion }>();
        for (const n of live.current.rig.skel.nodes) {
          const obj = root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n.name));
          if (obj) bones.set(n.name, { obj, rest: obj.quaternion.clone() });
        }
        const helper = new THREE.SkeletonHelper(root);
        (helper.material as THREE.LineBasicMaterial).depthTest = false;
        helper.renderOrder = 5;

        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        grid = new THREE.GridHelper(size * 3, 30, 0x4a505c, 0x30343c);
        grid.position.set(center.x, box.min.y, center.z);
        s.scene.add(root, helper, grid);
        s.camera.position.copy(center).add(new THREE.Vector3(0.55, 0.75, 0.65).multiplyScalar(size * 1.1));
        s.camera.near = size / 200;
        s.camera.far = size * 100;
        s.camera.updateProjectionMatrix();
        s.controls.target.copy(center);
        loaded.current = { root, bones, helper, size };
        document.body.dataset.modelLoaded = "1";
      },
      undefined,
      (err) => live.current.onStatus(`модель не загрузилась: ${String((err as Error)?.message ?? err)}`, true),
    );
    return () => {
      cancelled = true;
      const m = loaded.current;
      if (m) s.scene.remove(m.root, m.helper);
      if (grid) s.scene.remove(grid);
      loaded.current = null;
    };
  }, [props.modelUrl]);

  return <div className="viewport" ref={host} />;
}
