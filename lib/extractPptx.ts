// PPTX → 텍스트 추출.
// PPTX는 ZIP + Office Open XML 구조. ppt/slides/slide{N}.xml에 본문 텍스트가 <a:t> 태그로 들어있음.
// JSZip으로 unzip → XML 파싱해서 <a:t>만 모음. 슬라이드 번호 순서대로 정렬, 슬라이드 사이는 \n\n 구분.
// Speaker Notes(ppt/notesSlides/notesSlide{N}.xml)도 함께 추출: 학습 자료로서 발표자 노트도 의미 있음.
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  textNodeName: '#text',
  parseTagValue: false,
});

function collectTextNodes(node: unknown, into: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectTextNodes(n, into));
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'a:t') {
      if (typeof value === 'string') {
        into.push(value);
      } else if (Array.isArray(value)) {
        value.forEach((v) => { if (typeof v === 'string') into.push(v); });
      } else if (value && typeof value === 'object' && '#text' in (value as any)) {
        const t = (value as any)['#text'];
        if (typeof t === 'string') into.push(t);
      }
    } else if (value && typeof value === 'object') {
      collectTextNodes(value, into);
    }
  }
}

function slideNumberFromPath(p: string): number {
  const m = p.match(/(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function extractXmlText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) return '';
  const xml = await file.async('string');
  const parsed = xmlParser.parse(xml);
  const acc: string[] = [];
  collectTextNodes(parsed, acc);
  return acc.join(' ').replace(/\s+/g, ' ').trim();
}

export async function extractTextFromPptx(base64: string): Promise<{ text: string; slideCount: number }> {
  // base64 → bytes
  const raw = base64.includes(',') ? base64.split(',')[1] : base64;
  const binary = globalThis.atob(raw);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));

  const zip = await JSZip.loadAsync(bytes);

  // 슬라이드 + 노트 경로 수집
  const slidePaths: string[] = [];
  const notesPaths: string[] = [];
  zip.forEach((path) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) slidePaths.push(path);
    else if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(path)) notesPaths.push(path);
  });
  slidePaths.sort((a, b) => slideNumberFromPath(a) - slideNumberFromPath(b));
  notesPaths.sort((a, b) => slideNumberFromPath(a) - slideNumberFromPath(b));

  // 슬라이드별 본문 + 같은 번호 노트 매칭
  const notesByNum = new Map<number, string>();
  await Promise.all(notesPaths.map(async (p) => {
    const text = await extractXmlText(zip, p);
    if (text) notesByNum.set(slideNumberFromPath(p), text);
  }));

  const slidesText: string[] = [];
  for (const path of slidePaths) {
    const num = slideNumberFromPath(path);
    const body = await extractXmlText(zip, path);
    const note = notesByNum.get(num);
    const parts: string[] = [];
    if (body) parts.push(body);
    if (note) parts.push(`[발표자 노트] ${note}`);
    if (parts.length > 0) {
      slidesText.push(`# 슬라이드 ${num}\n${parts.join('\n')}`);
    }
  }

  return { text: slidesText.join('\n\n'), slideCount: slidePaths.length };
}
