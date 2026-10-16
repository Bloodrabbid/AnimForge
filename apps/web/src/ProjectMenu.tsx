// Меню «Проект»: проект одним файлом (.afproj — модель, клипы, пропы; открыть — перетащить в окно) и автосохранение:
// каждая правка кладёт прошлую версию в .autosave/, отсюда любую можно вернуть (текущая тоже уходит в историю).
import { useEffect, useState } from "react";
import { command } from "./api.ts";

interface Version {
  id: string;
  at: string;
  clips: number;
  names: string[];
}

export function ProjectMenu({ dir, close, say }: { dir: string; close(): void; say(text: string, error?: boolean): void }) {
  const [list, setList] = useState<Version[] | null>(null);
  useEffect(() => void command<Version[]>(dir, "project.history", {}).then(setList).catch(() => setList([])), [dir]);
  const restore = async (v: Version) => {
    try {
      await command(dir, "project.restore", { id: v.id });
      say(`возвращена версия ${new Date(v.at).toLocaleTimeString()} — текущая осталась в истории`);
    } catch (e) {
      say((e as Error).message, true);
    }
    close();
  };
  return (
    <div className="project-menu">
      <a className="menu-item" href={`/api/pack?${new URLSearchParams({ dir })}`} onClick={close} title="модель, клипы, пропы — одним файлом; открыть — перетащить в окно">
        Сохранить проект одним файлом (.afproj)
      </a>
      <div className="menu-sep" />
      <div className="menu-head">Автосохранение — версии до правок</div>
      {list == null && <div className="menu-item muted">загрузка…</div>}
      {list?.length === 0 && <div className="menu-item muted">пока нет: версия появится после первой правки</div>}
      <div className="history">
        {list?.slice(0, 30).map((v) => (
          <button key={v.id} className="menu-item hist" onClick={() => restore(v)} title={v.names.join(", ")}>
            <span>{new Date(v.at).toLocaleString()}</span>
            <span className="muted">клипов {v.clips}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
