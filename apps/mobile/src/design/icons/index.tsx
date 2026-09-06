import { IconBase, type IconProps } from './Icon';

export type { IconProps };

export const ClockIcon = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 1.8" />
  </IconBase>
);

export const HistoryIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.2 4.6v3.9h3.9" />
    <path d="M12 8v4.3l3 1.7" />
  </IconBase>
);

export const ShieldIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 3.2 5 6v5.4c0 4.1 2.8 7.4 7 9.4 4.2-2 7-5.3 7-9.4V6l-7-2.8Z" />
    <path d="m9.2 12.1 1.9 1.9 3.7-3.9" />
  </IconBase>
);

export const UsersIcon = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="9.5" cy="8.5" r="3.3" />
    <path d="M3.6 19.4a6.2 6.2 0 0 1 11.8 0" />
    <path d="M16.2 6a3.3 3.3 0 0 1 0 6.2" />
    <path d="M17.4 14.4a5.6 5.6 0 0 1 3 4.4" />
  </IconBase>
);

export const MapPinIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 21c4-4.1 6-7.3 6-9.9A6 6 0 0 0 6 11.1c0 2.6 2 5.8 6 9.9Z" />
    <circle cx="12" cy="11" r="2.4" />
  </IconBase>
);

export const DownloadIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 3.5v11" />
    <path d="m7.6 10.4 4.4 4.4 4.4-4.4" />
    <path d="M4.5 19.5h15" />
  </IconBase>
);

export const CheckIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="m5 12.6 4.6 4.6L19 6.9" />
  </IconBase>
);

export const CloseIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6" />
  </IconBase>
);

export const AlertIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 4.6 2.9 20.1h18.2L12 4.6Z" />
    <path d="M12 10.2v4.1" />
    <circle cx="12" cy="17.1" r="0.9" fill="currentColor" stroke="none" />
  </IconBase>
);

export const InfoIcon = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.2" />
    <circle cx="12" cy="7.9" r="0.95" fill="currentColor" stroke="none" />
  </IconBase>
);

export const ChevronRightIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </IconBase>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </IconBase>
);

export const ChevronDownIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="m5.5 9.2 6.5 6.5 6.5-6.5" />
  </IconBase>
);

export const SearchIcon = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </IconBase>
);

export const SunIcon = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.6v2.2M12 19.2v2.2M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.4 19.6 6 18M18 6l1.6-1.6" />
  </IconBase>
);

export const MoonIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
  </IconBase>
);

export const DeviceIcon = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="2.8" y="4.6" width="18.4" height="12" rx="2" />
    <path d="M8.5 20h7M12 16.6V20" />
  </IconBase>
);

export const LogOutIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
    <path d="M10.2 8.2 14 12l-3.8 3.8" />
    <path d="M14 12H4.5" />
  </IconBase>
);

export const PlusIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 5v14M5 12h14" />
  </IconBase>
);

export const EyeIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z" />
    <circle cx="12" cy="12" r="2.9" />
  </IconBase>
);

export const EyeOffIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M9.6 6.2A9.6 9.6 0 0 1 12 5.8c6 0 9.4 6.2 9.4 6.2a17 17 0 0 1-3 3.8" />
    <path d="M6.3 8.1A16.7 16.7 0 0 0 2.6 12S6 18.2 12 18.2a9.6 9.6 0 0 0 3.5-.65" />
    <path d="M10 10.1a2.9 2.9 0 0 0 4 4" />
    <path d="m4.4 4.4 15.2 15.2" />
  </IconBase>
);

export const MailIcon = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="5.2" width="18" height="13.6" rx="2.4" />
    <path d="m3.8 7.2 7.2 5.2a1.7 1.7 0 0 0 2 0l7.2-5.2" />
  </IconBase>
);

export const LockIcon = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="4.6" y="10.2" width="14.8" height="9.6" rx="2.4" />
    <path d="M8.2 10.2V7.9a3.8 3.8 0 0 1 7.6 0v2.3" />
  </IconBase>
);

export const InboxIcon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3.2 13.6 5.6 5.4A2 2 0 0 1 7.5 4h9a2 2 0 0 1 1.9 1.4l2.4 8.2" />
    <path d="M3.2 13.6h4.4l1.2 2.6h6.4l1.2-2.6h4.4v4a2.4 2.4 0 0 1-2.4 2.4H5.6a2.4 2.4 0 0 1-2.4-2.4Z" />
  </IconBase>
);
