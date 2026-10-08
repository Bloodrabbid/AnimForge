// Вьюпорт three.js. Поза считается вживую ядром (posePartsAt) на каждом кадре — без запекания и AnimationMixer,
// поэтому правка параметра рецепта, ключа или примерка пресета видны сразу.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewHelper } from "three/examples/jsm/helpers/ViewHelper.js";
import { posePartsAt, type Clip, type Project, type Rig } from "../../../packages/core/src/index.ts";

export type ViewCmd = { kind: "fit" | "front" | "side" | "top"; n: number };

interface Props {
  modelUrl: string;
  project: Project;
  rig: Rig;
  clip: Clip | undefined;
  t: number;
  selectedBone: string | null;
  showSkeleton: boolean;
  wireframe: boolean;
  showFloor: boolean;
  view: ViewCmd;
  onStatus(msg: string, error?: boolean): void;
}

interface Loaded {
  root: THREE.Object3D;
  bones: Map<string, { obj: THREE.Object3D; rest: THREE.Quaternion; restPos: THREE.Vector3; restScale: THREE.Vector3 }>;
  helper: THREE.SkeletonHelper;
  materials: THREE.Material[];
  size: number;
  center: THREE.Vector3;
  minY: number;
}

export function Viewport(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  // всё, что меняется часто, читаем из ref внутри цикла отрисовки
  const live = useRef(props);
  live.current = props;
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    sun: THREE.DirectionalLight;
    ground: THREE.Mesh;
    grid: THREE.GridHelper;
  } | null>(null);
  const loaded = useRef<Loaded | null>(null);

  // сцена, камера, цикл отрисовки — один раз
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0); // фон — градиент CSS под холстом
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe8eeff, 0x2a2622, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);
    const rim = new THREE.DirectionalLight(0xffc98a, 0.9);
    rim.position.set(-4, 3, -5);
    scene.add(rim);

    // пол: мягкая тень и сетка, которая растворяется к краям
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.ShadowMaterial({ opacity: 0.28 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    const grid = new THREE.GridHelper(1, 40, 0x5a5346, 0x34312c);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    scene.add(ground, grid);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    camera.position.set(2, 2, 3);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    sceneRef.current = { scene, camera, controls, sun, ground, grid };

    const gizmo = new ViewHelper(camera, renderer.domElement);
    gizmo.setLabels("X", "Y", "Z");
    const onPointerUp = (e: PointerEvent) => {
      gizmo.center.copy(controls.target);
      gizmo.handleClick(e);
    };
    renderer.domElement.addEventListener("pointerup", onPointerUp);

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
    const clock = new THREE.Clock();
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = live.current;
      const m = loaded.current;
      if (m) {
        // поза из ядра; кости, которых нет в позе, возвращаем в rest
        const pose = p.clip ? posePartsAt(p.project, p.rig, p.clip, p.t) : { rot: new Map(), pos: new Map(), scl: new Map() };
        for (const [name, { obj, rest, restPos, restScale }] of m.bones) {
          const q = pose.rot.get(name), v = pose.pos.get(name), s = pose.scl.get(name);
          if (q) obj.quaternion.set(q[0], q[1], q[2], q[3]);
          else obj.quaternion.copy(rest);
          if (v) obj.position.set(v[0], v[1], v[2]);
          else obj.position.copy(restPos);
          if (s) obj.scale.set(s[0], s[1], s[2]);
          else obj.scale.copy(restScale);
        }
        m.root.updateMatrixWorld(true);
        m.helper.visible = p.showSkeleton;
        for (const mat of m.materials) (mat as THREE.MeshStandardMaterial).wireframe = p.wireframe;
        ground.visible = grid.visible = p.showFloor;

        const sel = p.selectedBone ? m.bones.get(p.selectedBone) : undefined;
        marker.visible = segment.visible = !!sel;
        if (sel) {
          sel.obj.getWorldPosition(a);
          marker.position.copy(a);
          marker.scale.setScalar(m.size * 0.014);
          const child = sel.obj.children.find((c) => (c as THREE.Bone).isBone);
          if (child) child.getWorldPosition(b);
          else b.copy(a);
          segGeom.attributes.position.setXYZ(0, a.x, a.y, a.z);
          segGeom.attributes.position.setXYZ(1, b.x, b.y, b.z);
          segGeom.attributes.position.needsUpdate = true;
        }
      }
      const dt = clock.getDelta();
      if (gizmo.animating) gizmo.update(dt);
      controls.update();
      renderer.clear();
      renderer.render(scene, camera);
      gizmo.render(renderer);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      gizmo.dispose();
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
    new GLTFLoader().load(
      props.modelUrl,
      (gltf) => {
        if (cancelled) return;
        const root = gltf.scene;
        const materials: THREE.Material[] = [];
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.push(m);
          }
        });
        const bones = new Map<string, { obj: THREE.Object3D; rest: THREE.Quaternion; restPos: THREE.Vector3; restScale: THREE.Vector3 }>();
        for (const n of live.current.rig.skel.nodes) {
          const obj = root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n.name));
          if (obj) bones.set(n.name, { obj, rest: obj.quaternion.clone(), restPos: obj.position.clone(), restScale: obj.scale.clone() });
        }
        const helper = new THREE.SkeletonHelper(root);
        (helper.material as THREE.LineBasicMaterial).depthTest = false;
        helper.renderOrder = 5;

        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        s.ground.scale.setScalar(size * 1.6);
        s.ground.position.set(center.x, box.min.y, center.z);
        s.grid.scale.setScalar(size * 3);
        s.grid.position.set(center.x, box.min.y - size * 0.0005, center.z);
        // тень: камера солнца охватывает модель с запасом на шаги и взмахи
        const sc = s.sun.shadow.camera;
        sc.left = sc.bottom = -size;
        sc.right = sc.top = size;
        sc.near = size * 0.01;
        sc.far = size * 10;
        sc.updateProjectionMatrix();
        s.sun.position.copy(center).add(new THREE.Vector3(0.5, 1, 0.6).multiplyScalar(size * 2));
        s.sun.target.position.copy(center);
        s.scene.add(root, helper);
        loaded.current = { root, bones, helper, materials, size, center, minY: box.min.y };
        aim("fit");
        document.body.dataset.modelLoaded = "1";
      },
      undefined,
      (err) => live.current.onStatus(`модель не загрузилась: ${String((err as Error)?.message ?? err)}`, true),
    );
    return () => {
      cancelled = true;
      const m = loaded.current;
      if (m) s.scene.remove(m.root, m.helper);
      loaded.current = null;
    };
  }, [props.modelUrl]);

  /** Ракурсы камеры: целиком в три четверти, спереди (+Z glTF), сбоку, сверху. */
  const aim = (kind: ViewCmd["kind"]) => {
    const s = sceneRef.current, m = loaded.current;
    if (!s || !m) return;
    const dir = { fit: [0.55, 0.5, 0.8], front: [0, 0.12, 1], side: [1, 0.12, 0], top: [0, 1, 0.0001] }[kind];
    const dist = (m.size * 0.5) / Math.tan(THREE.MathUtils.degToRad(s.camera.fov / 2)) * 1.05;
    s.camera.position.copy(m.center).add(new THREE.Vector3(...dir).normalize().multiplyScalar(dist));
    s.camera.near = m.size / 200;
    s.camera.far = m.size * 100;
    s.camera.updateProjectionMatrix();
    s.controls.target.copy(m.center);
  };
  useEffect(() => {
    if (props.view.n) aim(props.view.kind);
  }, [props.view.n]);

  return <div className="viewport" ref={host} />;
}
