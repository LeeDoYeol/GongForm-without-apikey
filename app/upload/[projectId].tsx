import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ScrollView,
  Alert,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { IS_WEB, extractTextFromPdf, extractTextFromImage } from '@/lib/pdfUtils';
import { extractTextFromPptx } from '@/lib/extractPptx';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { FileInput, GenerationDensity } from '@/lib/gemini';
import { startGeneration } from '@/lib/generationManager';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, text as tk, screen } from '@/lib/theme';

type Step = 'file' | 'options' | 'generating' | 'done';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const ACCEPTED_TYPES = ['application/pdf', 'image/*', 'text/plain', PPTX_MIME];
const FILE_TYPE_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/plain': 'TXT',
  [PPTX_MIME]: 'PPTX',
};
function getFileTypeLabel(mime: string) {
  if (mime.startsWith('image/')) return '이미지';
  return FILE_TYPE_LABEL[mime] ?? '파일';
}

// 파일 → base64 (asset.base64 우선, 없으면 fetch + FileReader)
async function readAsBase64(asset: { base64?: string | null; uri: string }): Promise<string> {
  if (asset.base64) {
    return asset.base64.includes(',') ? asset.base64.split(',')[1] : asset.base64;
  }
  const response = await fetch(asset.uri);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function UploadScreen() {
  const { projectId, projectTitle: paramProjectTitle } = useLocalSearchParams<{
    projectId: string;
    projectTitle?: string;
  }>();
  const { user } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [fileMime, setFileMime] = useState('');
  const [fileInput, setFileInput] = useState<FileInput | null>(null);
  const [unitName, setUnitName] = useState('');
  const [startPage, setStartPage] = useState('');
  const [endPage, setEndPage] = useState('');
  const [projectTitle, setProjectTitle] = useState(paramProjectTitle ?? '');
  const [folderTitle, setFolderTitle] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [density, setDensity] = useState<GenerationDensity>('standard');

  const confirmPaste = () => {
    const content = pasteText.trim();
    if (content.length < 30) {
      Alert.alert('텍스트가 너무 짧습니다', '학습 자료가 될 만한 내용을 30자 이상 붙여넣어주세요.');
      return;
    }
    setFileInput({ kind: 'text', content });
    setFileName('직접 입력한 텍스트');
    setFileMime('text/plain');
    setStep('options');
    setPasteOpen(false);
    setPasteText('');
  };

  useEffect(() => {
    (async () => {
      const projDoc = await getDoc(doc(db, 'projects', projectId));
      if (!projDoc.exists()) return;
      const data = projDoc.data();
      if (!paramProjectTitle) setProjectTitle(data.title ?? '');
      setFolderId(data.folderId ?? null);
      if (data.folderId) {
        const fDoc = await getDoc(doc(db, 'folders', data.folderId));
        if (fDoc.exists()) setFolderTitle(fDoc.data().title);
      }
    })();
  }, [projectId, paramProjectTitle]);

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ACCEPTED_TYPES,
      copyToCacheDirectory: true,
      base64: true,
    });
    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    let mime = asset.mimeType ?? 'application/octet-stream';
    // PPTX는 DocumentPicker가 MIME을 못 잡는 경우(특히 일부 Android) 확장자 fallback
    if (mime === 'application/octet-stream' && asset.name?.toLowerCase().endsWith('.pptx')) {
      mime = PPTX_MIME;
    }

    try {
      if (mime === PPTX_MIME) {
        const base64 = await readAsBase64(asset);
        const { text, slideCount } = await extractTextFromPptx(base64);
        if (!text.trim()) {
          Alert.alert('알림', 'PPTX에서 추출된 텍스트가 없습니다. 그림 위주 슬라이드는 지원하지 않습니다.');
          return;
        }
        setFileInput({ kind: 'text', content: text, unitCount: slideCount });
      } else if (mime === 'text/plain') {
        let content: string;
        if (asset.base64) {
          const raw = asset.base64.includes(',') ? asset.base64.split(',')[1] : asset.base64;
          const binary = globalThis.atob(raw);
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          content = new TextDecoder('utf-8').decode(bytes);
        } else {
          const response = await fetch(asset.uri);
          content = await response.text();
        }
        setFileInput({ kind: 'text', content });
      } else if (mime === 'application/pdf' && IS_WEB) {
        const pdfBase64 = asset.base64
          ? (asset.base64.includes(',') ? asset.base64.split(',')[1] : asset.base64)
          : await fetch(asset.uri).then(r => r.blob()).then(blob => new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve((reader.result as string).split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            }));
        const { text, pageCount } = await extractTextFromPdf(pdfBase64);
        setFileInput({ kind: 'text', content: text, unitCount: pageCount });
      } else {
        let base64: string;
        if (asset.base64) {
          base64 = asset.base64.includes(',') ? asset.base64.split(',')[1] : asset.base64;
        } else {
          const response = await fetch(asset.uri);
          const blob = await response.blob();
          base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
        if (mime.startsWith('image/') && IS_WEB) {
          const content = await extractTextFromImage(base64, mime);
          setFileInput({ kind: 'text', content });
        } else {
          const mimeType = mime.startsWith('image/') ? mime : 'application/pdf';
          setFileInput({ kind: 'binary', base64, mimeType });
        }
      }
      setFileName(asset.name);
      setFileMime(mime);
      setStep('options');
    } catch (e: any) {
      console.error('[Upload] 오류:', e?.message ?? e);
      Alert.alert('오류', '파일을 읽을 수 없습니다.');
    }
  };

  const generate = () => {
    if (!fileInput) {
      Alert.alert('오류', '파일을 선택해주세요.');
      return;
    }
    if (!user) return;

    const pageRange =
      startPage && endPage
        ? { start: parseInt(startPage), end: parseInt(endPage) }
        : undefined;

    try {
      startGeneration({
        userId: user.uid,
        projectId,
        projectTitle: projectTitle || '프로젝트',
        folderId,
        fileInput,
        unitName,
        fileName,
        pageRange,
        density,
      });
    } catch (e: any) {
      Alert.alert('오류', e?.message ?? '작업 시작 실패');
      return;
    }
    router.replace({ pathname: '/project/[id]', params: { id: projectId } });
  };

  const goBack = () =>
    router.canGoBack()
      ? router.back()
      : router.replace({ pathname: '/project/[id]', params: { id: projectId } });

  useEffect(() => {
    if (step === 'generating' || step === 'done') setStep('file');
  }, [step]);

  return (
    <SafeAreaView style={screen.light}>
      <View style={s.header}>
        <TouchableOpacity onPress={goBack} style={s.backBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <View style={s.headerText}>
          <Text style={s.headerTitle}>AI 숏폼 생성</Text>
          <Text style={s.headerSubtitle}>자료를 올리면 AI가 학습 카드를 만들어드려요</Text>
          <View style={s.breadcrumb}>
            {folderTitle ? (
              <>
                <Text style={s.breadcrumbText}>📁 {folderTitle}</Text>
                <Text style={s.breadcrumbSep}> › </Text>
              </>
            ) : null}
            {projectTitle ? (
              <Text style={[s.breadcrumbText, { color: colors.accent }]}>
                <Ionicons name="layers-outline" size={11} color={colors.accent} /> {projectTitle}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {/* Step 1: 파일 선택 */}
        <StepCard number="1" title="자료 입력" done={!!fileName}>
          {!fileName ? (
            <View style={s.inputChooserCol}>
              <TouchableOpacity style={s.uploadBox} onPress={pickFile}>
                <Ionicons name="cloud-upload-outline" size={40} color={colors.ink3} />
                <Text style={s.uploadText}>PDF / 이미지 / TXT / PPTX</Text>
                <Text style={s.uploadHint}>탭하여 파일 선택</Text>
              </TouchableOpacity>
              <View style={s.orRow}>
                <View style={s.orLine} />
                <Text style={s.orText}>또는</Text>
                <View style={s.orLine} />
              </View>
              <TouchableOpacity style={s.pasteBox} onPress={() => setPasteOpen(true)}>
                <Ionicons name="clipboard-outline" size={22} color={colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={s.pasteTitle}>텍스트 직접 붙여넣기</Text>
                  <Text style={s.pasteHint}>강의 노트·복사한 글을 바로 입력</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.selectedRow}>
              <Ionicons
                name={
                  fileMime.startsWith('image/')
                    ? 'image-outline'
                    : fileMime === 'text/plain'
                    ? 'document-text-outline'
                    : 'document-outline'
                }
                size={20}
                color={colors.accent}
              />
              <Text style={s.selectedText} numberOfLines={1}>{' '}{fileName}</Text>
              <Text style={s.fileTypeTag}>{getFileTypeLabel(fileMime)}</Text>
              <TouchableOpacity
                onPress={() => {
                  setFileName('');
                  setFileInput(null);
                  setStep('file');
                }}
              >
                <Ionicons name="close-circle" size={20} color={colors.ink3} />
              </TouchableOpacity>
            </View>
          )}
        </StepCard>

        {/* Step 2: 페이지 범위 (PDF일 때만) */}
        <StepCard number="2" title="페이지 범위 (선택)" disabled={!fileName}>
          {(fileMime === 'application/pdf' || !fileMime) && (
            <>
              <View style={s.pageRow}>
                <TextInput
                  style={[s.input, s.pageInput]}
                  placeholder="시작 페이지"
                  placeholderTextColor={colors.ink4}
                  value={startPage}
                  onChangeText={setStartPage}
                  keyboardType="numeric"
                />
                <Text style={s.pageDash}>~</Text>
                <TextInput
                  style={[s.input, s.pageInput]}
                  placeholder="끝 페이지"
                  placeholderTextColor={colors.ink4}
                  value={endPage}
                  onChangeText={setEndPage}
                  keyboardType="numeric"
                />
              </View>
              <Text style={s.hint}>※ 페이지 범위 미입력 시 전체 분석</Text>
            </>
          )}
        </StepCard>

        {/* Step 3: 제목 (선택) - unitName */}
        <StepCard number="3" title="제목 (선택)" disabled={!fileName}>
          <TextInput
            style={s.input}
            placeholder="예: 2단원 세포의 구조"
            placeholderTextColor={colors.ink4}
            value={unitName}
            onChangeText={setUnitName}
            maxLength={60}
          />
          <Text style={s.hint}>※ AI가 생성할 콘텐츠의 단원·주제를 명시하면 정확도가 올라가요</Text>
        </StepCard>

        {/* Step 4: 생성 밀도 (추출 깊이 + 카드 수 제어) */}
        <StepCard number="4" title="생성 밀도" disabled={!fileName}>
          <View style={s.densityRow}>
            {(['summary', 'standard', 'detailed'] as const).map((d) => {
              const meta = d === 'summary'
                ? { label: '요약', sub: '핵심만 · 빠르게' }
                : d === 'standard'
                ? { label: '표준', sub: '균형 잡힘' }
                : { label: '상세', sub: '시험 대비' };
              const selected = density === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[s.densityCard, selected && s.densityCardOn]}
                  onPress={() => setDensity(d)}
                  activeOpacity={0.85}
                >
                  <Text style={[s.densityLabel, selected && s.densityLabelOn]}>{meta.label}</Text>
                  <Text style={s.densitySub}>{meta.sub}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={s.hint}>※ 기본 최대 30개 카드까지 생성돼요 (낮은 importance 자투리는 자동 제외)</Text>
        </StepCard>

        {fileName ? (
          <View style={s.bgHint}>
            <Ionicons name="information-circle-outline" size={14} color={colors.accent} />
            <Text style={s.bgHintText}>
              생성 중에 다른 화면으로 이동해도 돼요. 완료되면 우측 상단에 알림이 떠요.
            </Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[s.generateBtn, !fileName && s.disabledBtn]}
          onPress={fileName ? generate : undefined}
          disabled={!fileName}
        >
          <Ionicons name="sparkles-outline" size={18} color={colors.paper} />
          <Text style={s.generateBtnText}>  AI로 만들기 ✨</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 텍스트 붙여넣기 모달 */}
      <Modal visible={pasteOpen} transparent animationType="slide">
        <View style={s.pasteOverlay}>
          <View style={s.pasteSheet}>
            <View style={s.pasteHeader}>
              <Text style={s.pasteSheetTitle}>텍스트 붙여넣기</Text>
              <TouchableOpacity onPress={() => { setPasteOpen(false); setPasteText(''); }} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.ink2} />
              </TouchableOpacity>
            </View>
            <Text style={s.pasteSheetHint}>
              학습할 내용을 그대로 붙여넣으면 AI가 개념·예시·퀴즈로 변환합니다 (최소 30자).
            </Text>
            <TextInput
              style={s.pasteInput}
              value={pasteText}
              onChangeText={setPasteText}
              placeholder="여기에 텍스트를 붙여넣으세요..."
              placeholderTextColor={colors.ink4}
              multiline
              textAlignVertical="top"
              autoFocus
            />
            <Text style={s.pasteCount}>{pasteText.length.toLocaleString()}자</Text>
            <TouchableOpacity
              style={[s.pasteConfirmBtn, pasteText.trim().length < 30 && { opacity: 0.4 }]}
              onPress={confirmPaste}
              disabled={pasteText.trim().length < 30}
            >
              <Ionicons name="checkmark" size={16} color={colors.paper} />
              <Text style={s.pasteConfirmText}>이 텍스트로 진행</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function StepCard({
  number, title, done, disabled, children,
}: {
  number: string;
  title: string;
  done?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[stepStyles.card, disabled && stepStyles.cardDisabled]}>
      <View style={stepStyles.header}>
        <View style={[stepStyles.badge, done && stepStyles.badgeDone]}>
          {done ? (
            <Ionicons name="checkmark" size={14} color={colors.paper} />
          ) : (
            <Text style={stepStyles.badgeText}>{number}</Text>
          )}
        </View>
        <Text style={[stepStyles.title, disabled && stepStyles.titleDisabled]}>{title}</Text>
      </View>
      {!disabled && <View>{children}</View>}
    </View>
  );
}

const stepStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1.5, borderColor: colors.stroke,
  },
  cardDisabled: { opacity: 0.5 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  badge: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: colors.paper2, borderWidth: 1.5, borderColor: colors.stroke,
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  badgeDone: { backgroundColor: colors.good, borderColor: colors.good },
  badgeText: { fontFamily: fonts.body, color: colors.ink, fontWeight: '700', fontSize: 13 },
  title: { fontFamily: fonts.body, color: colors.ink, fontSize: 15 },
  titleDisabled: { color: colors.ink3 },
});

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.strokeSoft,
  },
  backBtn: { marginRight: 12 },
  headerText: { flex: 1 },
  headerTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 17 },
  headerSubtitle: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, marginTop: 2 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  breadcrumbText: { fontFamily: fonts.body, color: colors.ink3, fontSize: 12 },
  breadcrumbSep: { fontFamily: fonts.body, color: colors.ink4, fontSize: 12 },

  scroll: { padding: 16, paddingBottom: 40 },

  // 자료 입력 박스
  uploadBox: {
    borderWidth: 1.5, borderColor: colors.strokeDashed, borderStyle: 'dashed',
    borderRadius: radius.md,
    padding: 32, alignItems: 'center', gap: 6,
    backgroundColor: colors.paper2,
  },
  uploadText: { fontFamily: fonts.body, color: colors.ink, fontSize: 15 },
  uploadHint: { fontFamily: fonts.body, color: colors.ink3, fontSize: 12 },

  inputChooserCol: { gap: 10 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orLine: { flex: 1, height: 1, backgroundColor: colors.strokeSoft },
  orText: { fontFamily: fonts.mono, color: colors.ink3, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' },
  pasteBox: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 12,
    borderWidth: 1.5, borderColor: colors.accent,
  },
  pasteTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 14 },
  pasteHint: { fontFamily: fonts.body, color: colors.ink2, fontSize: 11, marginTop: 2 },

  // 파일 선택 후 카드
  selectedRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.paper2,
    borderWidth: 1.5, borderColor: colors.accent,
    borderRadius: 10, padding: 10,
  },
  selectedText: { flex: 1, fontFamily: fonts.body, color: colors.accent, fontSize: 14 },
  fileTypeTag: {
    fontFamily: fonts.mono,
    backgroundColor: colors.accent, color: colors.paper,
    fontSize: 11, fontWeight: '700',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6, marginRight: 8,
  },

  // 페이지 범위 입력
  input: {
    backgroundColor: colors.paper2,
    borderRadius: 10, padding: 12,
    fontFamily: fonts.body, color: colors.ink, fontSize: 15,
    borderWidth: 1.5, borderColor: colors.strokeSoft,
    marginBottom: 8,
  },
  pageRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pageInput: { flex: 1 },
  pageDash: { fontFamily: fonts.body, color: colors.ink3, fontSize: 18, marginBottom: 8 },
  hint: { fontFamily: fonts.body, color: colors.ink3, fontSize: 12 },

  // 밀도 선택
  densityRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  densityCard: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.stroke,
    backgroundColor: colors.paper2,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 2,
  },
  densityCardOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  densityLabel: { fontFamily: fonts.body, color: colors.ink, fontSize: 14, fontWeight: '700' },
  densityLabelOn: { color: colors.accentDeep },
  densitySub: { fontFamily: fonts.body, color: colors.ink3, fontSize: 11 },

  // 배경 안내
  bgHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentSoft,
    borderWidth: 1.5, borderColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 9, paddingHorizontal: 12,
    marginTop: 4, marginBottom: 10,
  },
  bgHintText: { fontFamily: fonts.body, color: colors.accentDeep, fontSize: 12, flex: 1, lineHeight: 17 },

  // 생성 버튼
  generateBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    padding: 16,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    marginTop: 4,
  },
  disabledBtn: { opacity: 0.4 },
  generateBtnText: { fontFamily: fonts.body, color: colors.paper, fontSize: 16, fontWeight: '700' },

  // 텍스트 붙여넣기 모달
  pasteOverlay: { flex: 1, backgroundColor: 'rgba(21,23,28,0.55)', justifyContent: 'flex-end' },
  pasteSheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 20, paddingBottom: 36,
    borderTopWidth: 1.5, borderColor: colors.stroke,
    maxHeight: '90%',
  },
  pasteHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6,
  },
  pasteSheetTitle: { fontFamily: fonts.body, color: colors.ink, fontSize: 17 },
  pasteSheetHint: { fontFamily: fonts.body, color: colors.ink2, fontSize: 12, marginBottom: 14, lineHeight: 18 },
  pasteInput: {
    backgroundColor: colors.paper2,
    borderWidth: 1.5, borderColor: colors.strokeSoft,
    borderRadius: radius.md, padding: 14,
    fontFamily: fonts.body, color: colors.ink, fontSize: 14,
    minHeight: 240, maxHeight: 360,
    lineHeight: 21,
  },
  pasteCount: { fontFamily: fonts.mono, color: colors.ink3, fontSize: 11, marginTop: 6, textAlign: 'right' },
  pasteConfirmBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 14, marginTop: 12,
  },
  pasteConfirmText: { fontFamily: fonts.body, color: colors.paper, fontSize: 15, fontWeight: '700' },
});
