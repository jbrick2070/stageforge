import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, DollarSign, Package, X } from 'lucide-react';
import type { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import { calculateProductionEstimate } from '../data/productionEstimator';
import { computeInventory } from '../data/equipmentInventory';
import { DEFAULT_SHOP_STATE, type ShopStockState } from '../data/shopStock';
import { CostCrewPanel } from './CostCrewPanel';
import { InventoryPanel } from './InventoryPanel';
import { InventoryPrintSheet } from './InventoryPrintSheet';

type GearTab = 'inventory' | 'cost';

const GEAR_TAB_STORAGE_KEY = 'stageforge.gearTab.v1';

function readInitialTab(): GearTab {
  try {
    const saved = window.localStorage.getItem(GEAR_TAB_STORAGE_KEY);
    return saved === 'cost' ? 'cost' : 'inventory';
  } catch {
    return 'inventory';
  }
}

function saveTab(tab: GearTab): void {
  try {
    window.localStorage.setItem(GEAR_TAB_STORAGE_KEY, tab);
  } catch {
    // Ignore storage errors in private browsing.
  }
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function getVisibleFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && window.getComputedStyle(el).visibility !== 'hidden',
  );
}

export interface CostEstimatorModalProps {
  rig: RigConfig;
  stage?: NativeStage;
  shopStock?: ShopStockState;
  onChangeShopStock?: (next: ShopStockState) => void;
  onClose: () => void;
  onDeployRig?: () => void;
  onNotify?: (message: string) => void;
}

export const CostEstimatorModal: React.FC<CostEstimatorModalProps> = ({
  rig,
  stage,
  shopStock = DEFAULT_SHOP_STATE,
  onChangeShopStock,
  onClose,
  onDeployRig,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<GearTab>(readInitialTab);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inventoryTabRef = useRef<HTMLButtonElement>(null);
  const costTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      opener?.focus();
    };
  }, []);

  const est = useMemo(() => calculateProductionEstimate(rig, stage), [rig, stage]);
  const inventory = useMemo(() => computeInventory(rig, stage, shopStock), [rig, stage, shopStock]);

  const selectTab = (next: GearTab, moveFocus = false) => {
    setActiveTab(next);
    saveTab(next);
    if (moveFocus) {
      requestAnimationFrame(() => {
        (next === 'inventory' ? inventoryTabRef : costTabRef).current?.focus();
      });
    }
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      selectTab(activeTab === 'inventory' ? 'cost' : 'inventory', true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectTab('inventory', true);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectTab('cost', true);
    }
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-modal="true"
        aria-labelledby="production-estimate-title"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const focusables = getVisibleFocusables(event.currentTarget);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const current = document.activeElement as HTMLElement | null;
          if (
            event.shiftKey
              ? !current || current === first || !event.currentTarget.contains(current)
              : current === last || !event.currentTarget.contains(current)
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }}
        className="gear-modal-backdrop fixed inset-0 m-0 w-full h-full max-w-none max-h-none border-0 bg-black/70 text-white backdrop-blur-md flex items-center justify-center p-0 sm:p-4"
      >
        <div className="gear-modal production-estimate glass-panel sm:rounded-2xl border border-white/15 w-full max-w-5xl h-[100dvh] sm:h-auto sm:max-h-[88vh] flex flex-col overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.9)]">
          {/* Sticky Header + ARIA Tabs */}
          <div className="gear-modal-header shrink-0 bg-black/75 border-b border-white/10">
            <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <ClipboardList className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden="true" />
                  <h2
                    id="production-estimate-title"
                    className="font-display font-bold text-base sm:text-lg text-white tracking-wide truncate"
                  >
                    Gear &amp; production
                  </h2>
                </div>
                <p className="font-mono-tech text-[11px] text-zinc-400 mt-0.5 truncate">
                  {rig.name} · Equipment inventory, shop limits, rental list &amp; crew estimate
                </p>
              </div>
              <button
                type="button"
                aria-label="Close gear and production"
                onClick={onClose}
                className="gear-touch-control inline-flex items-center justify-center p-2 rounded-lg bg-white/5 hover:bg-rose-500/25 text-zinc-300 cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>

            <div
              role="tablist"
              aria-label="Gear and production sections"
              className="flex items-stretch gap-1 px-4 sm:px-5"
            >
              <button
                ref={inventoryTabRef}
                id="gear-tab-inventory"
                role="tab"
                type="button"
                aria-selected={activeTab === 'inventory'}
                aria-controls="gear-panel-inventory"
                tabIndex={activeTab === 'inventory' ? 0 : -1}
                onClick={() => selectTab('inventory')}
                onKeyDown={handleTabKeyDown}
                className={`gear-touch-control inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold border-b-2 transition cursor-pointer ${
                  activeTab === 'inventory'
                    ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Package className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Inventory</span>
                {inventory.shortages.length > 0 && (
                  <span className="rounded-full bg-amber-500/25 border border-amber-400/50 px-1.5 py-0.5 font-mono-tech text-[9px] text-amber-200">
                    {inventory.shortages.length} short
                  </span>
                )}
              </button>
              <button
                ref={costTabRef}
                id="gear-tab-cost"
                role="tab"
                type="button"
                aria-selected={activeTab === 'cost'}
                aria-controls="gear-panel-cost"
                tabIndex={activeTab === 'cost' ? 0 : -1}
                onClick={() => selectTab('cost')}
                onKeyDown={handleTabKeyDown}
                className={`gear-touch-control inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold border-b-2 transition cursor-pointer ${
                  activeTab === 'cost'
                    ? 'border-emerald-400 text-emerald-200 bg-emerald-500/10'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <DollarSign className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Cost &amp; crew</span>
              </button>
            </div>
          </div>

          {/* Tab Panels */}
          {activeTab === 'inventory' ? (
            <div
              id="gear-panel-inventory"
              role="tabpanel"
              aria-labelledby="gear-tab-inventory"
              className="flex-1 min-h-0 flex flex-col overflow-hidden"
            >
              <InventoryPanel
                rig={rig}
                stage={stage}
                inventory={inventory}
                shopStock={shopStock}
                onChangeShopStock={(next) => onChangeShopStock?.(next)}
                onNotify={onNotify}
              />
            </div>
          ) : (
            <div
              id="gear-panel-cost"
              role="tabpanel"
              aria-labelledby="gear-tab-cost"
              className="flex-1 min-h-0 flex flex-col overflow-hidden"
            >
              <CostCrewPanel
                rig={rig}
                est={est}
                onFocusSafeControl={() => dialogRef.current?.querySelector('button')?.focus()}
                onDeployRig={onDeployRig}
              />
            </div>
          )}
        </div>
      </dialog>

      {activeTab === 'inventory' && (
        <InventoryPrintSheet rig={rig} inventory={inventory} shopStock={shopStock} />
      )}
    </>
  );
};

export default CostEstimatorModal;
