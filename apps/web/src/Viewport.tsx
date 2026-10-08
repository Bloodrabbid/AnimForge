// Вьюпорт three.js. Поза считается вживую ядром (posePartsAt) на каждом кадре — без запекания и AnimationMixer,
// поэтому правка параметра рецепта, ключа или примерка пресета видны сразу.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewHelper } from "three/examples/jsm/helpers/ViewHelper.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { posePartsAt, targetAt, type Clip, type Project, type Rig } from "../../../packages/core/src/index.ts";
import { WeightPainter, type Brush, type SkinPart } from "./weightPaint.ts";

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
  /** режим весов: тепловая карта выбранной кости и кисть (Alt или правая кнопка — камера) */
  weightMode?: boolean;
  brush?: Brush;
  onPainter?(p: WeightPainter | null): void;
  onStroke?(strokes: number): void;
  onPickBone?(bone: string): void;
  /** цели констрейнов: шарики во вьюпорте; активную тащат стрелками */
  showTargets?: boolean;
  activeTarget?: string | null;
  onMoveTarget?(id: string, pos: [number, number, number]): void;
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
  painter: WeightPainter;
  nameOf: Map<THREE.Object3D, string>;
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
  const recolor = useRef(true); // новая модель — тепловую карту пересчитать

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

    // кисть весов: перехватываем левую кнопку раньше OrbitControls (захват у цели срабатывает первым)
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let painting = false;
    const hitAt = (e: PointerEvent) => {
      const m = loaded.current;
      if (!m) return undefined;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.intersectObjects(m.painter.parts.map((p) => p.mesh), false)[0];
    };
    const dab = (e: PointerEvent) => {
      const m = loaded.current, p = live.current;
      const bone = p.selectedBone ? m?.bones.get(p.selectedBone)?.obj : undefined;
      const h = hitAt(e);
      if (!m || !bone || !h || !p.brush) return;
      const parent = (bone.parent as THREE.Bone)?.isBone ? bone.parent! : undefined;
      m.painter.dab(h.point, bone, parent, p.brush, m.size);
    };
    const down = (e: PointerEvent) => {
      const p = live.current, m = loaded.current;
      if (!p.weightMode || !m || e.button !== 0 || e.altKey) return;
      const h = hitAt(e);
      if (!h) return; // мимо модели — крутим камеру
      e.stopImmediatePropagation();
      if (e.metaKey || e.ctrlKey || e.shiftKey || !p.selectedBone) {
        const b = m.painter.boneAt(h);
        const name = b ? m.nameOf.get(b) : undefined;
        if (name) p.onPickBone?.(name);
        return;
      }
      painting = true;
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* синтетическое событие без настоящего указателя */
      }
      m.painter.beginStroke();
      dab(e);
    };
    let pending: PointerEvent | null = null;
    const move = (e: PointerEvent) => {
      if (!painting) return;
      if (!pending) requestAnimationFrame(() => pending && (dab(pending), (pending = null)));
      pending = e;
    };
    const up = () => {
      if (!painting) return;
      painting = false;
      live.current.onStroke?.(loaded.current?.painter.strokes ?? 0);
    };
    renderer.domElement.addEventListener("pointerdown", down, { capture: true });
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);

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
    // кости, упёршиеся в ограничение в этом кадре, — красные точки поверх меша
    const limGeo = new THREE.SphereGeometry(1, 12, 8);
    const limMat = new THREE.MeshBasicMaterial({ color: 0xff4d4d, depthTest: false, transparent: true, opacity: 0.9 });
    const limPool: THREE.Mesh[] = [];

    // цели констрейнов: шарик (IK — бирюзовый, взгляд — сиреневый) и линия от кончика или головы к цели
    const tgtGeo = new THREE.OctahedronGeometry(1, 1);
    const tgtPool: { mesh: THREE.Mesh; line: THREE.Line }[] = [];
    const tgtColor = { ik: 0x3fd0c9, aim: 0xb48cff };
    const handle = new THREE.Object3D(); // за него держит TransformControls
    scene.add(handle);
    const tc = new TransformControls(camera, renderer.domElement);
    tc.setSpace("world");
    tc.setSize(0.8);
    const tcHelper = tc.getHelper();
    scene.add(tcHelper);
    let drag: { id: string; pos: [number, number, number] } | null = null;
    tc.addEventListener("dragging-changed", (e) => {
      controls.enabled = !e.value;
      const p = live.current;
      if (e.value && p.activeTarget) drag = { id: p.activeTarget, pos: [handle.position.x, handle.position.y, handle.position.z] };
      else if (!e.value && drag) {
        const d = drag;
        drag = null;
        p.onMoveTarget?.(d.id, [handle.position.x, handle.position.y, handle.position.z].map((x) => +x.toFixed(4)) as [number, number, number]);
        dropUntil = performance.now() + 1500; // пока проект не перечитан — держим цель там, куда отпустили
        dropped = { id: d.id, pos: [handle.position.x, handle.position.y, handle.position.z] };
      }
    });
    tc.addEventListener("objectChange", () => {
      if (drag) drag.pos = [handle.position.x, handle.position.y, handle.position.z];
    });
    let dropUntil = 0;
    let dropped: { id: string; pos: [number, number, number] } | null = null;
    let lastProject: Project | null = null;

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
    let lastSel = "";
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = live.current;
      const m = loaded.current;
      if (m) {
        // поза из ядра; кости, которых нет в позе, возвращаем в rest
        if (p.project !== lastProject) {
          lastProject = p.project;
          dropUntil = 0;
        }
        // цель тащат прямо сейчас (или только что отпустили) — поза считается с ней, без ожидания сервера
        const over = drag ?? (performance.now() < dropUntil ? dropped : null);
        let clipNow = p.clip;
        if (over && clipNow?.constraints) {
          clipNow = { ...clipNow, constraints: clipNow.constraints.map((c) => (c.id === over.id ? { ...c, target: { pos: over.pos } } : c)) };
        }
        const pose: ReturnType<typeof posePartsAt> = clipNow ? posePartsAt(p.project, p.rig, clipNow, p.t) : { rot: new Map(), pos: new Map(), scl: new Map() };
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
        m.painter.setActive(!!p.weightMode);
        const selKey = p.weightMode ? `${p.selectedBone}` : "";
        if (p.weightMode && (selKey !== lastSel || recolor.current)) (recolor.current = false), m.painter.recolor(p.selectedBone ? m.bones.get(p.selectedBone)?.obj : undefined);
        lastSel = selKey;
        ground.visible = grid.visible = p.showFloor;

        const lim = [...(pose.limited ?? [])].map((b) => m.bones.get(b)).filter((x) => !!x);
        while (limPool.length < lim.length) {
          const s = new THREE.Mesh(limGeo, limMat);
          s.renderOrder = 11;
          scene.add(s);
          limPool.push(s);
        }
        limPool.forEach((s, k) => {
          s.visible = k < lim.length;
          if (s.visible) {
            lim[k]!.obj.getWorldPosition(s.position);
            s.scale.setScalar(m.size * 0.011);
          }
        });
        // цели
        const cons = p.showTargets && clipNow?.constraints ? clipNow.constraints : [];
        while (tgtPool.length < cons.length) {
          const mesh = new THREE.Mesh(tgtGeo, new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 }));
          mesh.renderOrder = 12;
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ depthTest: false, dashSize: 0.02, gapSize: 0.015, transparent: true, opacity: 0.8 }));
          line.renderOrder = 12;
          scene.add(mesh, line);
          tgtPool.push({ mesh, line });
        }
        let activeAt: THREE.Vector3 | null = null;
        let activeMovable = false;
        tgtPool.forEach(({ mesh, line }, k) => {
          const c = cons[k];
          const tp = c ? targetAt(p.rig, pose, clipNow!, c.target, p.t) : null;
          mesh.visible = line.visible = !!tp;
          if (!c || !tp) return;
          const isActive = c.id === p.activeTarget;
          mesh.position.set(tp[0], tp[1], tp[2]);
          mesh.scale.setScalar(m.size * (isActive ? 0.016 : 0.011));
          const col = c.muted ? 0x777777 : tgtColor[c.type];
          (mesh.material as THREE.MeshBasicMaterial).color.set(col);
          (line.material as THREE.LineDashedMaterial).color.set(col);
          const from = m.bones.get(c.type === "ik" ? c.tip : c.bones[c.bones.length - 1])?.obj;
          if (from) from.getWorldPosition(b);
          else b.copy(mesh.position);
          const g = line.geometry;
          g.attributes.position.setXYZ(0, b.x, b.y, b.z);
          g.attributes.position.setXYZ(1, tp[0], tp[1], tp[2]);
          g.attributes.position.needsUpdate = true;
          line.computeLineDistances();
          (line.material as THREE.LineDashedMaterial).dashSize = m.size * 0.012;
          (line.material as THREE.LineDashedMaterial).gapSize = m.size * 0.008;
          if (isActive) {
            activeAt = mesh.position;
            activeMovable = !c.target.bone;
          }
        });
        if (activeAt && activeMovable) {
          if (!drag) handle.position.copy(activeAt);
          if (tc.object !== handle) tc.attach(handle);
        } else if (tc.object) tc.detach();
        // для проверок (screenshot.ts AF_DRAG): где на экране центр ручки активной цели
        (window as any).__afHandle = tc.object
          ? () => {
              const v = handle.position.clone().project(camera), r = renderer.domElement.getBoundingClientRect();
              return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
            }
          : null;
        const sel = p.selectedBone ? m.bones.get(p.selectedBone) : undefined;
        marker.visible = segment.visible = !!sel;
        if (sel) {
          sel.obj.getWorldPosition(a);
          marker.position.copy(a);
          marker.scale.setScalar(m.size * 0.014);
          (marker.material as THREE.MeshBasicMaterial).color.set(pose.limited?.has(p.selectedBone!) ? 0xff4d4d : 0xffb547);
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
      renderer.domElement.removeEventListener("pointerdown", down, { capture: true });
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      gizmo.dispose();
      tc.dispose();
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
        // части кожи для весов: какой меш и примитив glb за каким SkinnedMesh (GLTFLoader помнит в associations)
        const parts: SkinPart[] = [];
        root.traverse((o) => {
          const sm = o as THREE.SkinnedMesh;
          if (!sm.isSkinnedMesh) return;
          const a = gltf.parser.associations.get(sm) as { meshes?: number; primitives?: number } | undefined;
          if (a?.meshes == null) return;
          parts.push({ mesh: sm, meshIndex: a.meshes, primitive: a.primitives ?? 0, material: sm.material });
        });
        const painter = new WeightPainter(parts);
        const nameOf = new Map<THREE.Object3D, string>([...bones].map(([n, b]) => [b.obj, n]));
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
        loaded.current = { root, bones, helper, materials, size, center, minY: box.min.y, painter, nameOf };
        recolor.current = true;
        live.current.onPainter?.(painter);
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
      live.current.onPainter?.(null);
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
