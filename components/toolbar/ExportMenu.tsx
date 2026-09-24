'use client';

import { ChevronDown, Download, FileImage, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type ExportFormat = 'pdf' | 'image/png' | 'image/jpeg';

interface Props {
  busy: string | undefined;
  canExportPdf: boolean;
  canExportPage: boolean;
  pageCount: number;
  pageNumber: number;
  onExport(f: ExportFormat): void;
}

/** One primary Export button; formats in a menu (Design.md: ink primary button). */
export function ExportMenu({ busy, canExportPdf, canExportPage, pageCount, pageNumber, onExport }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-9 gap-1.5 rounded-lg px-3.5" disabled={!!busy} aria-label={busy ?? 'Export'}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          <span className="hidden sm:inline">{busy ?? 'Export'}</span>
          {!busy && <ChevronDown className="opacity-70" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="type-label text-muted-foreground">Export edited document</DropdownMenuLabel>
        <DropdownMenuItem disabled={!canExportPdf} onSelect={() => onExport('pdf')} className="items-start gap-2.5 py-2">
          <FileText className="mt-0.5" />
          <span>
            <span className="block font-medium">PDF</span>
            <span className="block text-[12px] text-muted-foreground">
              {canExportPdf ? (pageCount > 1 ? `All ${pageCount} pages, original page sizes` : 'Original page size') : 'Available once all pages are read'}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {(['image/png', 'image/jpeg'] as const).map((f) => (
          <DropdownMenuItem key={f} disabled={!canExportPage} onSelect={() => onExport(f)} className="items-start gap-2.5 py-2">
            <FileImage className="mt-0.5" />
            <span>
              <span className="block font-medium">{f === 'image/png' ? 'PNG' : 'JPEG'}</span>
              <span className="block text-[12px] text-muted-foreground">
                {pageCount > 1 ? (
                  <>
                    Page <span className="type-num">{pageNumber}</span> only
                  </>
                ) : f === 'image/png' ? (
                  'Lossless image'
                ) : (
                  'Smaller file'
                )}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
