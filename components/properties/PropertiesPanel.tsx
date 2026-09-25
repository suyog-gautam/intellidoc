'use client';

import { AlignCenter, AlignLeft, AlignRight, Check, PenLine, ClipboardCopy, ClipboardPaste, Loader2, Pipette, RotateCcw, Trash2, Undo } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { EditCommand } from '@/core/document/history';
import { elementIsModified, type RenderParams, type TextAlignment, type TextElement } from '@/core/document/model';
import { getFont, hasFont } from '@/core/typography/fontCatalog';
import { glyphStyle } from '@/core/typography/styleTransfer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { CopiedStyle, ElementStatus } from '../editor/useEditor';
import { FontPicker } from './FontPicker';

interface Props {
  element: TextElement | undefined;
  status: ElementStatus | undefined;
  overflowing: boolean;
  run(cmd: EditCommand): void;
  copiedStyle: CopiedStyle | undefined;
  onCopyStyle(): void;
  onPasteStyle(): void;
  onPickStyle(): void;
  picking: boolean;
  /** Text of the element the style was taken from, if any. */
  styleSourceText?: string;
  /** Style analysis failed for this text; it stays as scanned until "Original says" is corrected. */
  styleUnavailable?: boolean;
  /** Re-read the element with the handwriting model; resolves false if nothing credible was read. Absent when unavailable. */
  onReadHandwriting?(): Promise<boolean>;
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}

const toHex = (c: readonly number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

/** Design.md tag colours for OCR confidence. */
function ConfidenceTag({ value }: { value: number }) {
  const tone = value >= 85 ? 'bg-ok-light text-ok-text' : value >= 60 ? 'bg-warn-light text-warn' : 'bg-danger-light text-danger-text';
  const label = value >= 85 ? 'Read confidently' : value >= 60 ? 'Check this text' : 'Likely misread';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium', tone)}>
      {label}
      <span className="type-num">{Math.round(value)}%</span>
    </span>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="type-label text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Handwriting is misread by the print OCR: offer the handwriting model for doubtful text. */
function ReadHandwriting({ read }: { read(): Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'reading' | 'failed'>('idle');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-full text-[12.5px]"
        disabled={state === 'reading'}
        onClick={async () => {
          setState('reading');
          setState((await read().catch(() => false)) ? 'idle' : 'failed');
        }}
      >
        {state === 'reading' ? <Loader2 className="animate-spin" /> : <PenLine />} Read as handwriting
      </Button>
      {state === 'failed' && <span className="text-[12px] text-tertiary">Couldn&apos;t read it. Type the text above.</span>}
    </div>
  );
}

/** Visible, in-context progress for the selected text (not just a toolbar hint). */
function StatusLine({ status, done }: { status: ElementStatus | undefined; done: boolean }) {
  if (status)
    return (
      <p role="status" className="flex items-center gap-2 rounded-sm bg-brand-light px-2.5 py-1.5 text-[12.5px] font-medium text-brand-text">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {status === 'analyzing' ? 'Matching the original style…' : 'Updating the page preview…'}
      </p>
    );
  if (done)
    return (
      <p role="status" className="flex items-center gap-2 text-[12.5px] text-ok-text">
        <Check className="size-3.5" aria-hidden /> Applied to the page
      </p>
    );
  return null;
}

const inputClass = 'h-10 rounded-md border-transparent bg-canvas px-3 text-[14px] focus-visible:bg-surface focus-visible:border-brand focus-visible:ring-brand/20';

export function PropertiesPanel(p: Props) {
  const { element, status, overflowing, run } = p;
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [size, setSize] = useState('');
  const [inkDraft, setInkDraft] = useState<string>();
  useEffect(() => {
    setText(element?.text ?? '');
    setSource(element?.sourceText ?? '');
  }, [element?.id, element?.text, element?.sourceText]);
  const overrideSize = element?.styleOverrides?.fontSize;
  useEffect(() => setSize(overrideSize !== undefined ? String(Number(overrideSize.toFixed(1))) : ''), [element?.id, overrideSize]);
  // The colour picker fires continuously while dragging: commit once it settles.
  useEffect(() => {
    if (!inkDraft || !element) return;
    const timer = setTimeout(() => {
      run({ type: 'applyStyle', elementId: element.id, style: { color: fromHex(inkDraft) } });
      setInkDraft(undefined);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inkDraft]);

  if (!element) {
    return (
      <div className="p-5">
        <p className="type-title">Nothing selected</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Select text on the page to edit it. Double-click, or press <kbd className="type-num rounded-sm bg-canvas px-1">Enter</kbd>, to edit in place. Use{' '}
          <span className="font-medium text-foreground">Add text</span> to place new text.
        </p>
        <div className="mt-5 grid gap-2 text-[12.5px] text-muted-foreground">
          <Legend className="border-brand bg-brand-light" label="Recognised text" />
          <Legend className="border-[#d97a00] bg-warn-light" label="Check: medium confidence" />
          <Legend className="border-danger bg-danger-light" label="Likely misread" />
          <Legend className="border-ok bg-ok-light" label="Edited or added" />
        </div>
      </div>
    );
  }

  const added = element.origin === 'added';
  const commitText = () => text !== element.text && run({ type: 'setText', elementId: element.id, text });
  const t = element.typography;
  const o = element.styleOverrides ?? {};
  const detectedFont = t ? getFont(t.params.fontId) : undefined;
  const effective: RenderParams | undefined = t && { ...t.params, ...o, ...glyphStyle(t.params, o) };
  const apply = (style: Partial<RenderParams>) => run({ type: 'applyStyle', elementId: element.id, style });
  const commitSize = () => {
    const v = parseFloat(size);
    const next = Number.isFinite(v) && v >= 4 ? v : undefined;
    if (next !== o.fontSize) apply({ fontSize: next });
  };

  return (
    <div className="space-y-6 p-5">
      <Section title={added ? 'Added text' : 'Text'}>
        <div className="space-y-1.5">
          <Label htmlFor="new-text">{added ? 'Text' : 'New text'}</Label>
          <Input
            id="new-text"
            className={inputClass}
            value={text}
            placeholder={added ? 'Type text…' : undefined}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => e.key === 'Enter' && commitText()}
          />
          <StatusLine status={status} done={!status && elementIsModified(element)} />
          {overflowing && <p className="rounded-sm bg-warn-light px-2.5 py-1.5 text-[12px] text-warn">Longer than the available space. It was tightened as far as allowed and may overflow.</p>}
        </div>
        {!added && (
          <div className="space-y-1.5">
            <Label htmlFor="source-text">Original says</Label>
            <Input
              id="source-text"
              className={inputClass}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onBlur={() => source !== element.sourceText && run({ type: 'setSourceText', elementId: element.id, sourceText: source })}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ConfidenceTag value={element.ocrConfidence} />
              <span className="text-[12px] text-tertiary">Fix OCR mistakes here</span>
            </div>
            {element.recognizer === 'handwriting' && <p className="text-[12px] text-muted-foreground">Read by the handwriting model. Please check it.</p>}
            {/* Offered whatever the confidence: print OCR is often confidently wrong on handwriting. */}
            {p.onReadHandwriting && element.recognizer !== 'handwriting' && <ReadHandwriting key={element.id} read={p.onReadHandwriting} />}
          </div>
        )}
        {added && <p className="text-[12px] text-tertiary">Drag the box on the page to move it, or use the arrow keys.</p>}
      </Section>

      {!added && (
        <Section title="Alignment">
          <ToggleGroup
            type="single"
            variant="outline"
            value={element.alignment}
            onValueChange={(v) => v && run({ type: 'setAlignment', elementId: element.id, alignment: v as TextAlignment })}
            aria-label="Alignment"
            className="w-full *:flex-1 *:data-[state=on]:bg-primary *:data-[state=on]:text-primary-foreground"
          >
            <ToggleGroupItem value="left" aria-label="Align left">
              <AlignLeft />
            </ToggleGroupItem>
            <ToggleGroupItem value="center" aria-label="Align centre">
              <AlignCenter />
            </ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label="Align right">
              <AlignRight />
            </ToggleGroupItem>
          </ToggleGroup>
        </Section>
      )}

      <Separator />

      <Section
        title="Style"
        action={
          element.styleOverrides &&
          !added && (
            <Button variant="ghost" size="sm" className="h-7 rounded-full px-2.5 text-[12px]" onClick={() => run({ type: 'setStyleOverrides', elementId: element.id, overrides: undefined })}>
              <RotateCcw /> Reset to detected
            </Button>
          )
        }
      >
        {!t && p.styleUnavailable ? (
          <p className="rounded-sm bg-warn-light px-2.5 py-1.5 text-[12.5px] text-warn">
            The style of this text couldn&apos;t be matched, so it stays as scanned. Check &ldquo;Original says&rdquo; above; correcting it retries the match.
          </p>
        ) : !t ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Analysing the original style…
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="font">Font</Label>
              <FontPicker id="font" value={o.fontId} detected={detectedFont!} text={element.text || element.sourceText} onChange={(fontId) => apply(fontId ? { fontId } : { fontId: undefined, fontSize: undefined, scaleX: undefined, letterSpacing: undefined })} />
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={String(effective!.weight >= 700 ? 700 : 400)}
                onValueChange={(v) => v && apply({ weight: Number(v), fontId: o.fontId ?? t.params.fontId })}
                aria-label="Weight"
                className="w-full *:flex-1 *:data-[state=on]:bg-primary *:data-[state=on]:text-primary-foreground"
              >
                <ToggleGroupItem value="400">Regular</ToggleGroupItem>
                <ToggleGroupItem value="700" className="font-semibold">
                  Bold
                </ToggleGroupItem>
              </ToggleGroup>
              <GlyphVariants params={effective!} />
            </div>

            {getFont(effective!.fontId).category === 'handwriting' && (
              <div className="space-y-1.5">
                <Label id="variation-label">Natural variation</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={String(nearestVariation(effective!.jitter ?? 0))}
                  onValueChange={(v) => v && apply({ jitter: Number(v) })}
                  aria-labelledby="variation-label"
                  className="w-full *:flex-1 *:data-[state=on]:bg-primary *:data-[state=on]:text-primary-foreground"
                >
                  {VARIATIONS.map((v) => (
                    <ToggleGroupItem key={v.value} value={String(v.value)}>
                      {v.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p className="text-[11px] text-tertiary">Handwriting is never the same twice: every character gets its own baseline, slant, size, shape and pen pressure.</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="size">Size (px)</Label>
                <Input
                  id="size"
                  type="number"
                  inputMode="decimal"
                  min={4}
                  max={400}
                  step={0.5}
                  className={cn(inputClass, 'type-num')}
                  placeholder={t.params.fontSize.toFixed(1)}
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  onBlur={commitSize}
                  onKeyDown={(e) => e.key === 'Enter' && commitSize()}
                  aria-describedby="size-hint"
                />
                <p id="size-hint" className="text-[11px] text-tertiary">
                  Empty = auto
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ink">Ink colour</Label>
                <div className="flex h-10 items-center gap-2 rounded-md bg-canvas px-2">
                  <input
                    id="ink"
                    type="color"
                    className="size-7 cursor-pointer rounded-sm border border-border-mid bg-transparent p-0"
                    value={inkDraft ?? toHex(effective!.color)}
                    onChange={(e) => setInkDraft(e.target.value)}
                  />
                  <span className="type-num min-w-0 truncate text-[12px] text-muted-foreground">{o.color ? toHex(o.color) : 'Auto'}</span>
                </div>
                {o.color ? (
                  <button type="button" className="text-[11px] font-medium text-brand hover:underline" onClick={() => apply({ color: undefined })}>
                    Use detected colour
                  </button>
                ) : (
                  <p className="text-[11px] text-tertiary">Detected from the scan</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Copy style from other text</Label>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" className="h-9 rounded-lg px-2 text-[12.5px]" onClick={p.onCopyStyle}>
                  <ClipboardCopy /> Copy
                </Button>
                <Button variant="outline" className="h-9 rounded-lg px-2 text-[12.5px]" onClick={p.onPasteStyle} disabled={!p.copiedStyle || p.copiedStyle.sourceId === element.id}>
                  <ClipboardPaste /> Paste
                </Button>
                <Button variant={p.picking ? 'default' : 'outline'} className="h-9 rounded-lg px-2 text-[12.5px]" onClick={p.onPickStyle} aria-pressed={p.picking}>
                  <Pipette /> Match
                </Button>
              </div>
              <p className="text-[11px] text-tertiary">
                {p.picking
                  ? 'Click any recognised text, on any page, to use its style.'
                  : p.copiedStyle
                    ? `Copied: ${p.copiedStyle.label}`
                    : 'Match takes the style of any text you click; Copy/Paste works across pages.'}
              </p>
              {p.styleSourceText && (
                <p className="text-[12px] text-muted-foreground">
                  Style from <span className="font-medium text-foreground">“{p.styleSourceText}”</span>
                </p>
              )}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-border pt-3 text-[13px]">
              <dt className="text-muted-foreground">Detected</dt>
              <dd>
                {detectedFont!.displayName} {t.params.weight >= 700 ? 'Bold' : 'Regular'}
                <span className="block text-[12px] text-tertiary">looks like {detectedFont!.resembles.join(' / ')} · estimate</span>
              </dd>
              <dt className="text-muted-foreground">Width</dt>
              <dd className="type-num">{pct(t.params.scaleX)}</dd>
              <dt className="text-muted-foreground">Rotation</dt>
              <dd className="type-num">{((t.frame.angle * 180) / Math.PI).toFixed(2)}°</dd>
              {!added && (
                <>
                  <dt className="text-muted-foreground">Visual match</dt>
                  <dd>
                    <span className="type-num">{pct(t.fidelity.silhouetteIoU)}</span>
                    <span className="ml-1.5 text-[12px] text-tertiary">shape overlap</span>
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
      </Section>

      <div className="flex flex-wrap gap-2">
        {element.state === 'deleted' ? (
          <Button variant="outline" className="rounded-lg" onClick={() => run({ type: 'restoreElement', elementId: element.id })}>
            <RotateCcw /> Restore text
          </Button>
        ) : (
          <Button variant="ghost" className="rounded-lg text-danger hover:bg-danger-light hover:text-danger-text" onClick={() => run({ type: 'deleteElement', elementId: element.id })}>
            <Trash2 /> {added ? 'Remove text box' : 'Remove text'}
          </Button>
        )}
        {!added && element.text !== element.sourceText && (
          <Button variant="outline" className="rounded-lg" onClick={() => run({ type: 'setText', elementId: element.id, text: element.sourceText })}>
            <Undo /> Revert text
          </Button>
        )}
      </div>
    </div>
  );
}

const VARIATIONS = [
  { value: 0, label: 'Off' },
  { value: 0.35, label: 'Subtle' },
  { value: 0.7, label: 'Natural' },
  { value: 1, label: 'Strong' },
];

function nearestVariation(j: number): number {
  return VARIATIONS.reduce((best, v) => (Math.abs(v.value - j) < Math.abs(best - j) ? v.value : best), 0);
}

/** Characters drawn from another font because the scan's design differs (e.g. a "1" without a foot). */
function GlyphVariants({ params }: { params: RenderParams }) {
  const swaps = Object.entries(params.glyphFonts ?? {}).filter(([, id]) => id !== params.fontId && hasFont(id));
  const written = Object.keys(params.glyphSamples ?? {}).filter((c) => c.trim());
  if (!swaps.length && !written.length) return null;
  return (
    <>
      {written.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          Writer’s own handwriting reused for <span className="font-medium text-foreground">{written.join(' ')}</span>. Other characters use the matched hand-style font.
        </p>
      )}
      {swaps.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          Matched to the scan:{' '}
          {swaps.map(([ch, id], i) => (
            <span key={ch}>
              {i > 0 && ', '}“<span className="font-medium text-foreground">{ch}</span>” from {getFont(id).displayName}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn('h-3 w-5 rounded-[3px] border-2', className)} />
      {label}
    </span>
  );
}
