/**
 * Robust file download utility - works in ALL environments:
 * Standard browsers, mobile, Mac/Windows/Linux
 *
 * Simple, reliable approach:
 * 1. Create Blob
 * 2. Create object URL
 * 3. Create hidden <a> element, append to body, click, remove
 * 4. Fallback to data URI if blob URL fails
 * 5. Last resort: open in new window
 */

export function downloadFile(content: string, filename: string, mimeType: string): void {
  // Method 1: Blob URL (works in all modern browsers, handles large files)
  try {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '-9999px';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.click();
    // Clean up after download starts
    setTimeout(() => {
      if (document.body.contains(a)) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 5000);
    return;
  } catch {
    // fall through to next method
  }

  // Method 2: Data URI (works for smaller files < 2MB)
  try {
    if (content.length < 2_000_000) {
      const dataUri = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
      const a = document.createElement('a');
      a.href = dataUri;
      a.download = filename;
      a.style.position = 'fixed';
      a.style.left = '-9999px';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) document.body.removeChild(a);
      }, 3000);
      return;
    }
  } catch {
    // fall through
  }

  // Method 3: Open in new window/tab
  try {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (w) {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
  } catch {
    // fall through
  }

  // Method 4: Alert with instructions
  alert(
    `Download failed to start automatically.\n\n` +
    `Please try:\n` +
    `1. Allow popups for this site in your browser settings\n` +
    `2. Try a different browser (Chrome, Firefox, Edge)\n` +
    `3. Use the "Copy JSON" button and paste into a text editor, save as "${filename}"`
  );
}