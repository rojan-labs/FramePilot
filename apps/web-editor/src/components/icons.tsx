/**
 * The editor's icon set (PROMPT §4 — replace emoji with a real, minimal icon set).
 *
 * One module re-exports every icon the UI uses from `lucide-react` (MIT/ISC,
 * tree-shakeable, monoline). Importing from here — never reaching into
 * `lucide-react` ad hoc — keeps the icon language consistent (no mixed
 * outline/filled styles) and gives a single place to swap the set later.
 *
 * Icons inherit `currentColor` and are sized on a 16/18/20 grid via {@link ICON_SIZE}.
 * Icon-only controls must still carry an `aria-label`/`title` at the call site.
 */
export {
  Film,
  Lightbulb,
  Monitor,
  Clapperboard,
  Home,
  AudioLines,
  Music,
  Image,
  Check,
  AlertTriangle,
  Minus,
  Pencil,
  Folder,
  Sparkles,
  Type,
  Captions,
  Wand2,
  SlidersHorizontal,
  FileText,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  // Prev/next EDIT POINT. Deliberately distinct from ChevronLeft/Right (prev/next
  // FRAME) and from SkipBack/Forward (jump to start/end) — three adjacent pairs of
  // transport buttons that must not read as the same gesture at a glance.
  ChevronFirst,
  ChevronLast,
  Frame,
  Repeat,
  Copy,
  Scissors,
  Combine,
  Trash2,
  ListX,
  MessageCircleQuestion,
  Flag,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Undo2,
  Redo2,
  Download,
  HardDrive,
  X,
  Search,
  Volume2,
  VolumeX,
  Lock,
  LockOpen,
  Keyboard,
  Settings,
  Plus,
  FolderOpen,
  FolderPlus,
  Upload,
  Save,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Contrast,
  Eye,
  EyeOff,
  Star,
  Square,
  ImagePlus,
  MessageSquare,
  ArrowLeftRight,
  Scan,
  Palette,
  MoreHorizontal,
  Headphones,
  GripHorizontal,
  Map,
  Send,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  History,
  Key,
  Grid3x3 as Grid,
  Info,
  HelpCircle,
  Zap,
  Hand,
  MousePointer2,
  Magnet,
  Ban,
  Wifi,
  WifiOff,
  Gauge,
  Crop,
  Layers,
  BookOpen,
  Wrench,
  CloudUpload,
  Bookmark,
  // The keyframe marker, in the inspector and (Phase 6) on the timeline. Outline at
  // rest, filled via CSS when a keyframe sits at the playhead, so the two states read
  // apart by shape weight and not by colour alone.
  Diamond,
  Paperclip,
} from 'lucide-react';
export type { LucideIcon } from 'lucide-react';

/** Consistent icon sizes (px) on a 16/18/20 grid. */
export const ICON_SIZE = {
  /** Dense controls: tabs, list rows. */
  sm: 16,
  /** Default: toolbar and transport buttons. */
  md: 18,
  /** Emphasis: primary transport. */
  lg: 20,
} as const;
