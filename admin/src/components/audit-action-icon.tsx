import {
  ArrowRightLeft,
  ArrowUpRight,
  FileEdit,
  FolderEdit,
  Globe,
  Layers,
  type LucideIcon,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  Replace,
  RotateCcw,
  Settings,
  ToggleLeft,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AuditAction } from '@/lib/schemas';

const ACTION_ICONS: Record<AuditAction, LucideIcon> = {
  create: Plus,
  update: Pencil,
  delete: Trash2,
  toggle: ToggleLeft,
  seed: Layers,
  migrate: ArrowRightLeft,
  transfer: ArrowUpRight,
  r2_upload: Upload,
  r2_delete: Trash2,
  r2_rename: FolderEdit,
  r2_move: ArrowRightLeft,
  r2_replace: Replace,
  r2_metadata_update: FileEdit,
  r2_cache_purge: RotateCcw,
  r2_comment_update: MessageSquare,
  feedback_create: MessageSquarePlus,
  feedback_triage: Pencil,
  feedback_delete: Trash2,
  r2_object_create: Globe,
  r2_object_delete: Globe,
  cf_config_change: Settings,
};

export function AuditActionIcon({
  action,
  className,
}: {
  action: AuditAction;
  className?: string;
}): React.ReactElement {
  const Icon = ACTION_ICONS[action];
  return <Icon className={className ?? 'size-3'} />;
}
