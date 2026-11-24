import React from 'react';
import {
  specToSvgPath,
  symbolFor,
  symbolForHardware,
  type Path2DSpec,
} from '../data/equipmentSymbols';
import type { CatalogBodyFamily, HardwareType } from '../data/equipmentCatalog';

interface EquipmentThumbnailProps {
  family?: CatalogBodyFamily;
  type?: HardwareType;
  catalogId?: string;
  /** Accessible label; when omitted, the thumbnail is decorative (`aria-hidden="true"`). */
  label?: string;
  className?: string;
}

function fillClass(fill: Path2DSpec['fill']): string {
  switch (fill) {
    case 'lens':
      return 'fill-cyan-300/80 stroke-cyan-200';
    case 'accent':
      return 'fill-amber-400/75 stroke-amber-300';
    case 'none':
      return 'fill-none stroke-zinc-300';
    case 'body':
    default:
      return 'fill-zinc-700/90 stroke-zinc-300';
  }
}

export const EquipmentThumbnail: React.FC<EquipmentThumbnailProps> = ({
  family,
  type,
  catalogId,
  label,
  className = 'w-5 h-5 shrink-0',
}) => {
  const symbol = family
    ? symbolFor(family, catalogId)
    : type
      ? symbolForHardware(type, catalogId)
      : symbolFor('moving-beam', catalogId);

  return (
    <svg
      viewBox="-1 -1 2 2"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-equipment-family={symbol.family}
    >
      {symbol.elevation.map((spec, idx) => (
        <path
          key={idx}
          d={specToSvgPath(spec, true)}
          className={fillClass(spec.fill)}
          strokeWidth={0.09}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
};
