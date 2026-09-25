import { Lock, ScanText, Type } from 'lucide-react';
import type { OpenProgress } from '@/lib/session/documentSession';
import { AppHeader } from '../AppHeader';
import { UploadCard } from '../upload/UploadCard';

const FEATURES = [
  { icon: ScanText, title: 'Reads your scan', text: 'OCR finds every line of text and where it sits on the page, including values inside tables. English, Nepali, Hindi and more.' },
  { icon: Type, title: 'Matches the look', text: 'New text copies the original size, weight, ink colour, blur and paper grain. Fonts are visual estimates.' },
  { icon: Lock, title: 'Stays on your device', text: 'Recognition, editing and export all run in your browser. Nothing is uploaded.' },
];

interface Props {
  onFile(file: File): void;
  onIntent(): void;
  progress?: OpenProgress;
  error?: string;
  languages: string[];
  onLanguages(codes: string[]): void;
}

export function StartScreen({ onFile, onIntent, progress, error, languages, onLanguages }: Props) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 content-center items-stretch gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_minmax(0,460px)] lg:gap-16 lg:py-16">
        <section aria-labelledby="hero-title" className="max-w-xl">
          <p className="type-label text-muted-foreground">Scanned document editor</p>
          <h1 id="hero-title" className="type-headline mt-3 sm:type-display">
            Edit scanned documents. Keep the original look.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Change a date, a name or a number in a scanned PDF or photo. IntelliDoc removes the old text, rebuilds the paper underneath and
            renders the new text to match the scan.
          </p>
          <ul className="mt-8 grid gap-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3 rounded-xl border border-border bg-surface p-3">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-brand-light text-brand-text">
                  <Icon className="size-4" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-[13px] text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <UploadCard onFile={onFile} onIntent={onIntent} progress={progress} error={error} languages={languages} onLanguages={onLanguages} />
      </main>
    </div>
  );
}
