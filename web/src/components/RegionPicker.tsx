import { useMemo, useState } from 'react';
import { DISTRICTS, REGIONS, regionName } from '@shared/regions';
import { Icon } from './Icons';
import { Button, cx, Input, Modal, toast } from './ui';
import { getPosition, regionAtPoint } from '../lib/geo';
import { useApp } from '../lib/store';

export function RegionList({
  value,
  onSelect,
  multi,
  selected = [],
  maxHeight = 'max-h-[46dvh]',
}: {
  value?: string | null;
  onSelect: (id: string) => void;
  multi?: boolean;
  selected?: string[];
  maxHeight?: string;
}) {
  const [q, setQ] = useState('');
  const [locating, setLocating] = useState(false);
  const { alerts } = useApp();
  const active = useMemo(() => new Set(alerts.map((a) => a.regionId)), [alerts]);
  const groups = useMemo(() => {
    const norm = q.trim().toLowerCase().replace(/ё/g, 'е');
    const list = REGIONS.filter(
      (r) => !norm || [r.name, r.short, r.capital].some((s) => s.toLowerCase().replace(/ё/g, 'е').includes(norm)),
    );
    return DISTRICTS.map((d) => ({ d, items: list.filter((r) => r.district === d) })).filter((g) => g.items.length);
  }, [q]);

  const locate = async () => {
    setLocating(true);
    try {
      const [lon, lat] = await getPosition();
      const id = await regionAtPoint(lon, lat);
      if (!id) throw new Error('Вы вне территории карты — выберите регион вручную');
      onSelect(id);
      toast(`Определено: ${regionName(id)}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLocating(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dim" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Регион или город…" className="pl-9" />
        </div>
        <Button variant="outline" onClick={locate} loading={locating} title="Определить по геолокации">
          <Icon name="locate" className="size-4" />
          <span className="hidden sm:inline">Где я?</span>
        </Button>
      </div>
      <div className={cx('-mx-1 overflow-y-auto px-1', maxHeight)}>
        {groups.map((g) => (
          <div key={g.d} className="mb-3">
            <div className="sticky top-0 z-10 bg-panel/95 py-1 text-[11px] font-bold uppercase tracking-wider text-dim backdrop-blur">{g.d}</div>
            {g.items.map((r) => {
              const isSel = multi ? selected.includes(r.id) : value === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onSelect(r.id)}
                  className={cx(
                    'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition',
                    isSel ? 'bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgba(52,227,255,0.35)]' : 'hover:bg-white/5',
                  )}
                >
                  <span>
                    <span className="font-semibold">{r.name}</span>
                    <span className="ml-2 text-xs text-dim">{r.capital}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {active.has(r.id) && <span className="size-2 animate-pulse-soft rounded-full bg-alert" title="Тревога" />}
                    {isSel && <Icon name="check" className="size-4" />}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && <div className="py-8 text-center text-sm text-muted">Ничего не найдено</div>}
      </div>
    </div>
  );
}

export function RegionPickerModal({
  open,
  onClose,
  value,
  onSelect,
  title = 'Выберите регион',
}: {
  open: boolean;
  onClose: () => void;
  value?: string | null;
  onSelect: (id: string) => void;
  title?: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <RegionList
        value={value}
        onSelect={(id) => {
          onSelect(id);
          onClose();
        }}
        maxHeight="max-h-[60dvh]"
      />
    </Modal>
  );
}
