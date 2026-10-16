// Скелет по ручным точкам (как у Mixamo): восемь точек кликом по коже спереди — подбородок, пах, запястья, локти,
// колени — и число пальцев. Остальные суставы — по пропорциям (model.autorig с markers), имена Mixamo.
// Зеркало: точка левой стороны ставит и правую — отражением поперёк тела через подбородок.
import { Icon } from "./Icon.tsx";
import { MARKS, type MarkKey, type Marks } from "./marks.ts";

interface Props {
  marks: Marks;
  active: MarkKey | null;
  mirror: boolean;
  count: number;
  busy: boolean;
  onActive(k: MarkKey): void;
  onMirror(v: boolean): void;
  onCount(n: number): void;
  onClear(): void;
  onBuild(): void;
}

export function MarkerPanel({ marks, active, mirror, count, busy, onActive, onMirror, onCount, onClear, onBuild }: Props) {
  const done = MARKS.filter((m) => marks[m.key]).length;
  return (
    <div className="weights panel markers">
      <p className="muted">Кликните по коже спереди, по порядку. Глубину точки найдём сами — середину тела на этой линии.</p>
      <ul className="mk-list">
        {MARKS.map((m) => (
          <li key={m.key} className={m.key === active ? "on" : ""} onClick={() => onActive(m.key)}>
            <i style={{ background: marks[m.key] ? m.color : "transparent", borderColor: m.color }} />
            {m.title}
            {marks[m.key] && <Icon name="check" size={12} />}
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={mirror} onChange={(e) => onMirror(e.target.checked)} /> зеркально: левая точка ставит и правую
      </label>
      <label className="param">
        <span className="pname">пальцы</span>
        <select value={count} onChange={(e) => onCount(Number(e.target.value))}>
          <option value={5}>5 — с большим</option>
          <option value={4}>4 — без большого</option>
          <option value={3}>3</option>
          <option value={2}>2</option>
          <option value={1}>1 — варежка</option>
          <option value={0}>без пальцев</option>
        </select>
      </label>
      <div className="w-actions">
        <button onClick={onClear} disabled={!done || busy}>
          Сбросить
        </button>
        <button className="btn accent" onClick={onBuild} disabled={done < MARKS.length || busy}>
          <Icon name="check" /> Построить скелет{done < MARKS.length ? ` (${done}/${MARKS.length})` : ""}
        </button>
      </div>
      <ul className="w-help muted">
        <li>Камера — Alt + мышь, правая кнопка или клик мимо модели. Точку можно переставить: выберите её в списке.</li>
        <li>Скелет заменит прежний (модель до этого — рядом, .prerig.glb); цепочки найдутся заново.</li>
        <li>Пальцы ставятся шаблоном веером, даже у кисти-варежки; веса — по ближайшим костям.</li>
      </ul>
    </div>
  );
}
