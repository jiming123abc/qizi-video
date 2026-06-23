export const isWeChat = () => {
  if (typeof window === 'undefined') return false;
  return /MicroMessenger/i.test(navigator.userAgent);
};

export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    }
  } catch (err) {
    console.error('Failed to copy: ', err);
    return false;
  }
};

const setMetaTag = (nameOrProperty: string, value: string, isProperty: boolean = false) => {
  const attr = isProperty ? 'property' : 'name';
  let meta = document.querySelector(`meta[${attr}="${nameOrProperty}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute(attr, nameOrProperty);
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', value);
};

export const setupShareMetadata = (config: {
  title: string;
  desc: string;
  link: string;
  imgUrl: string;
}) => {
  document.title = config.title;
  
  setMetaTag('og:title', config.title, true);
  setMetaTag('og:description', config.desc, true);
  setMetaTag('og:image', config.imgUrl, true);
  setMetaTag('og:url', config.link, true);
  setMetaTag('og:type', 'website', true);
  setMetaTag('og:site_name', 'AI数字影像工作室', true);
  
  setMetaTag('description', config.desc, false);
  
  setMetaTag('twitter:card', 'summary_large_image', false);
  setMetaTag('twitter:title', config.title, false);
  setMetaTag('twitter:description', config.desc, false);
  setMetaTag('twitter:image', config.imgUrl, false);
};

export const injectWeChatSDK = () => {
};
