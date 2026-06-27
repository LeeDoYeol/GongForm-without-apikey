export const IS_WEB = typeof document !== 'undefined';

export async function extractTextFromImage(base64: string, mimeType: string): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('kor+eng');
  const { data: { text } } = await worker.recognize(`data:${mimeType};base64,${base64}`);
  await worker.terminate();
  return text;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export async function extractTextFromPdf(base64: string): Promise<{ text: string; pageCount: number }> {
  const version = '3.11.174';
  await loadScript(`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.min.js`);

  const pdfjsLib = (window as any).pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.worker.min.js`;

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const texts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: any) => item.str).join(' ');
    texts.push(`[${i}페이지]\n${pageText}`);
  }

  return { text: texts.join('\n\n'), pageCount: pdf.numPages };
}
