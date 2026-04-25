// Lucide-style thin-stroke icons (1.5 stroke), sized via className
const Icon = ({ d, size = 18, className = "", strokeWidth = 1.5, fill = "none", children }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
       fill={fill} stroke="currentColor" strokeWidth={strokeWidth}
       strokeLinecap="round" strokeLinejoin="round" className={className}>
    {children || <path d={d} />}
  </svg>
);

const IconPlus      = (p) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
const IconUpload    = (p) => <Icon {...p}><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></Icon>;
const IconLink      = (p) => <Icon {...p}><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></Icon>;
const IconClipText  = (p) => <Icon {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></Icon>;
const IconDatabase  = (p) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></Icon>;
const IconSearch    = (p) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
const IconClose     = (p) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
const IconCheck     = (p) => <Icon {...p}><path d="M5 13l4 4L19 7" /></Icon>;
const IconCopy      = (p) => <Icon {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Icon>;
const IconArrowUp   = (p) => <Icon {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Icon>;
const IconSend      = (p) => <Icon {...p}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" /></Icon>;
const IconSparkle   = (p) => <Icon {...p}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></Icon>;
const IconFileText  = (p) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6M9 9h2" /></Icon>;
const IconGlobe     = (p) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>;
const IconQuote     = (p) => <Icon {...p}><path d="M7 7h4v6H5V9a2 2 0 0 1 2-2Z" /><path d="M15 7h4v6h-6V9a2 2 0 0 1 2-2Z" /></Icon>;
const IconChat      = (p) => <Icon {...p}><path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z" /></Icon>;
const IconList      = (p) => <Icon {...p}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></Icon>;
const IconBookmark  = (p) => <Icon {...p}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></Icon>;
const IconFilter    = (p) => <Icon {...p}><path d="M3 5h18l-7 9v6l-4-2v-4z" /></Icon>;
const IconChevDown  = (p) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
const IconPlay      = (p) => <Icon {...p}><path d="M8 5v14l11-7z" /></Icon>;
const IconMore      = (p) => <Icon {...p}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Icon>;
const IconAttach    = (p) => <Icon {...p}><path d="m21 12-9.5 9.5a5.5 5.5 0 0 1-7.78-7.78L13 4.44a3.67 3.67 0 0 1 5.19 5.19L9.41 18.4a1.83 1.83 0 0 1-2.59-2.59L15 7.61" /></Icon>;
const IconRefresh   = (p) => <Icon {...p}><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 21v-5h5" /></Icon>;
const IconBeaker    = (p) => <Icon {...p}><path d="M9 3h6" /><path d="M10 3v6L4 19a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 19l-6-10V3" /><path d="M7 14h10" /></Icon>;
const IconPdf       = (p) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><text x="7.5" y="17" fontSize="6" fontFamily="Inter" fontWeight="700" stroke="none" fill="currentColor">PDF</text></Icon>;

Object.assign(window, {
  Icon, IconPlus, IconUpload, IconLink, IconClipText, IconDatabase, IconSearch,
  IconClose, IconCheck, IconCopy, IconArrowUp, IconSend, IconSparkle, IconFileText,
  IconGlobe, IconQuote, IconChat, IconList, IconBookmark, IconFilter, IconChevDown,
  IconPlay, IconMore, IconAttach, IconRefresh, IconBeaker, IconPdf,
});
