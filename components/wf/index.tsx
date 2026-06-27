// Wireframe primitives (RN port of design's wf-primitives.jsx).
// Sketchy + cobalt blue, paper background. See lib/theme.ts for tokens.
import React from 'react';
import {
  View, Text, TouchableOpacity, ViewStyle, TextStyle, StyleProp,
  ActivityIndicator, GestureResponderEvent, StyleSheet,
} from 'react-native';
import { colors, fonts, radius, shadow, text as t, box as boxStyles } from '@/lib/theme';

// Box
export interface BoxProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  dashed?: boolean;
  fill?: boolean;
  accent?: boolean;
  ink?: boolean;
  pill?: boolean;
  sharp?: boolean;
}
export function Box({ children, style, dashed, fill, accent, ink, pill, sharp }: BoxProps) {
  return (
    <View
      style={[
        boxStyles.base,
        dashed && boxStyles.dashed,
        fill && boxStyles.fill,
        accent && boxStyles.accent,
        ink && boxStyles.ink,
        pill && boxStyles.pill,
        sharp && boxStyles.sharp,
        style,
      ]}
    >
      {children}
    </View>
  );
}

// Chip
export interface ChipProps {
  children: React.ReactNode;
  accent?: boolean;
  ink?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}
export function Chip({ children, accent, ink, style, textStyle }: ChipProps) {
  const bg = ink ? colors.ink : accent ? colors.accentSoft : 'transparent';
  const border = ink ? colors.ink : accent ? colors.accent : colors.stroke;
  const fg = ink ? colors.paper : accent ? colors.accentDeep : colors.ink;
  return (
    <View style={[chipStyles.base, { backgroundColor: bg, borderColor: border }, style]}>
      <Text style={[chipStyles.text, { color: fg }, textStyle]}>{children}</Text>
    </View>
  );
}
const chipStyles = StyleSheet.create({
  base: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: { fontFamily: fonts.body, fontSize: 13, lineHeight: 15, fontWeight: '600' },
});

// Btn
export interface BtnProps {
  children: React.ReactNode;
  onPress?: (e: GestureResponderEvent) => void;
  primary?: boolean;
  ghost?: boolean;
  lg?: boolean;
  full?: boolean;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}
export function Btn({
  children, onPress, primary, ghost, lg, full, loading, disabled, style, textStyle,
}: BtnProps) {
  // hi-fi 다크 톤: primary는 solid accent (보더 없음, 강한 채움)
  //                secondary는 paper2 배경 + 1px stroke (서브 액션)
  //                ghost는 dashed (저강도)
  const bg = primary ? colors.accent : ghost ? 'transparent' : colors.paper2;
  const border = primary ? colors.accent : ghost ? colors.strokeDashed : colors.stroke;
  const fg = primary ? '#fff' : ghost ? colors.ink2 : colors.ink;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={disabled || loading}
      onPress={onPress}
      style={[
        btnStyles.base,
        lg && btnStyles.lg,
        full && { alignSelf: 'stretch' },
        {
          backgroundColor: bg,
          borderColor: border,
          borderStyle: ghost ? 'dashed' : 'solid',
          borderWidth: primary ? 0 : 1,
        },
        disabled && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[btnStyles.text, lg && btnStyles.textLg, { color: fg }, textStyle]}>
          {children}
        </Text>
      )}
    </TouchableOpacity>
  );
}
const btnStyles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  lg: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: radius.lg },
  text: { fontFamily: fonts.body, fontSize: 16, fontWeight: '700' },
  textLg: { fontSize: 17 },
});

// ImgSlot
// Diagonal-slash image placeholder. Two crossed thin Views approximate the design's CSS gradient X.
export interface ImgSlotProps {
  label?: string;
  w?: number | string;
  h?: number | string;
  dashed?: boolean;
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
}
export function ImgSlot({ label = 'image', w, h, dashed, dark, style }: ImgSlotProps) {
  // 다크 hi-fi: 카드 표면 톤 위에 옅은 슬래시 placeholder
  const slashColor = 'rgba(255,255,255,0.12)';
  const bg = dark ? '#000' : colors.paper2;
  const fg = colors.ink3;
  const border = dark ? 'rgba(255,255,255,0.2)' : colors.stroke;
  return (
    <View
      style={[
        imgStyles.base,
        {
          width: (w as any) ?? '100%',
          height: (h as any) ?? 120,
          backgroundColor: bg,
          borderColor: border,
          borderStyle: dashed ? 'dashed' : 'solid',
        },
        style,
      ]}
    >
      {/* diagonal slashes */}
      <View pointerEvents="none" style={[imgStyles.slash1, { backgroundColor: slashColor }]} />
      <View pointerEvents="none" style={[imgStyles.slash2, { backgroundColor: slashColor }]} />
      <Text style={[imgStyles.label, { color: fg }]}>{label}</Text>
    </View>
  );
}
const imgStyles = StyleSheet.create({
  base: {
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  slash1: {
    position: 'absolute',
    left: '-25%',
    right: '-25%',
    top: '50%',
    height: 1.5,
    transform: [{ rotate: '45deg' }],
  },
  slash2: {
    position: 'absolute',
    left: '-25%',
    right: '-25%',
    top: '50%',
    height: 1.5,
    transform: [{ rotate: '-45deg' }],
  },
  label: { fontFamily: fonts.mono, fontSize: 11, textAlign: 'center', zIndex: 1 },
});

// Bars (lorem text bars)
export interface BarsProps {
  lines?: number;
  last?: number; // 0..100 percent
  thin?: boolean;
  dark?: boolean;
  accent?: boolean;
  gap?: number;
  width?: number | string;
}
export function Bars({ lines = 3, last = 70, thin, dark, accent, gap = 6, width = '100%' }: BarsProps) {
  const color = accent ? colors.accent : dark ? 'rgba(255,255,255,0.25)' : colors.ink4;
  const h = thin ? 6 : 8;
  return (
    <View style={{ width: width as any, gap }}>
      {Array.from({ length: lines }).map((_, i) => (
        <View
          key={i}
          style={{
            height: h,
            borderRadius: 4,
            backgroundColor: color,
            width: i === lines - 1 ? (`${last}%` as any) : '100%',
          }}
        />
      ))}
    </View>
  );
}

// Avatar
export interface AvatarProps {
  initials?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}
export function Avatar({ initials = 'A', size = 36, style }: AvatarProps) {
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: colors.stroke,
          backgroundColor: colors.paper2,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Text style={{ fontFamily: fonts.display, fontSize: size * 0.5, color: colors.ink2 }}>
        {initials}
      </Text>
    </View>
  );
}

// Icon glyph (geometric placeholder, single char)
// Used when a wireframe-style icon is wanted instead of Ionicons.
export interface IconGlyphProps {
  children?: React.ReactNode;
  size?: number;
  circle?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}
export function IconGlyph({ children, size = 22, circle, color = colors.ink, style }: IconGlyphProps) {
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderWidth: 1.5,
          borderColor: color,
          borderRadius: circle ? size / 2 : radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Text style={{ fontFamily: fonts.mono, fontSize: size * 0.5, color }}>{children}</Text>
    </View>
  );
}

// Hr / Line
export function Hr({ dashed, accent, thin, style }: { dashed?: boolean; accent?: boolean; thin?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          borderTopWidth: thin ? 1 : 1.5,
          borderTopColor: accent ? colors.accent : thin ? colors.strokeSoft : colors.stroke,
          borderStyle: dashed ? 'dashed' : 'solid',
        },
        style,
      ]}
    />
  );
}

// Re-export text styles for screens to use directly.
export { text as wfText } from '@/lib/theme';
