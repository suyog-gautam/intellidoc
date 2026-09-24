'use client';

import { Check, ChevronLeft, ChevronRight, Maximize2, Minus, MoreHorizontal, Plus, Redo2, TextCursorInput, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Page } from '@/core/document/model';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type ViewMode = 'edited' | 'original' | 'side-by-side';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  zoom: number;
  onZoom(z: number): void;
  onFit(): void;
  view: ViewMode;
  onView(v: ViewMode): void;
  showOverlays: boolean;
  onToggleOverlays(v: boolean): void;
  pageIndex: number;
  pages: readonly Page[];
  onPage(i: number): void;
  status: string | undefined;
  /** "Add text" placement mode. */
  adding: boolean;
  onToggleAdd(): void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;

function IconButton({ label, shortcut, onClick, disabled, children }: { label: string; shortcut?: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={shortcut ? `${label} (${shortcut})` : label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="type-num ml-2 opacity-70">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const Sep = () => <Separator orientation="vertical" className="mx-1.5 hidden h-5 sm:block" />;

const PAGE_STATUS: Record<Page['status'], string> = { pending: ' · queued', processing: ' · reading', ready: '', failed: ' · failed' };

/**
 * Secondary toolbar. It never scrolls horizontally:
 *  - phones: undo/redo, view switch and a "more" menu (zoom, text boxes);
 *    multi-page navigation wraps onto its own centred row;
 *  - sm+: one row; lower-priority items appear as width allows;
 *  - lg+: page navigation moves to the thumbnail rail.
 */
export function Toolbar(p: Props) {
  const multi = p.pages.length > 1;
  const zoomOut = () => p.onZoom(Math.max(MIN_ZOOM, p.zoom / 1.25));
  const zoomIn = () => p.onZoom(Math.min(MAX_ZOOM, p.zoom * 1.25));
  return (
    <div role="toolbar" aria-label="Editor tools" className="flex shrink-0 flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-border bg-surface px-2 py-1.5 sm:h-12 sm:flex-nowrap sm:gap-x-1 sm:px-4 sm:py-0">
      <IconButton label="Undo" shortcut="Ctrl+Z" onClick={p.onUndo} disabled={!p.canUndo}>
        <Undo2 />
      </IconButton>
      <IconButton label="Redo" shortcut="Ctrl+Y" onClick={p.onRedo} disabled={!p.canRedo}>
        <Redo2 />
      </IconButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={p.adding ? 'default' : 'ghost'}
            className="h-8 gap-1.5 rounded-lg px-2 sm:px-2.5"
            aria-pressed={p.adding}
            aria-label="Add text"
            onClick={p.onToggleAdd}
          >
            <TextCursorInput />
            <span className="hidden lg:inline">Add text</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add a text box: click where it should go</TooltipContent>
      </Tooltip>

      {multi && (
        // Own centred row on phones; inline on tablets; the rail replaces it on lg+.
        <div className="order-last flex basis-full items-center justify-center border-t border-border pt-1 sm:order-none sm:basis-auto sm:border-0 sm:pt-0 lg:hidden">
          <Sep />
          <IconButton label="Previous page" onClick={() => p.onPage(p.pageIndex - 1)} disabled={p.pageIndex === 0}>
            <ChevronLeft />
          </IconButton>
          <Select value={String(p.pageIndex)} onValueChange={(v) => p.onPage(Number(v))}>
            <SelectTrigger size="sm" aria-label="Page" className="type-num min-w-[96px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {p.pages.map((pg) => (
                <SelectItem key={pg.id} value={String(pg.index)}>
                  <span className="type-num">
                    {pg.index + 1} / {p.pages.length}
                  </span>
                  <span className="text-muted-foreground">{PAGE_STATUS[pg.status]}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IconButton label="Next page" onClick={() => p.onPage(p.pageIndex + 1)} disabled={p.pageIndex >= p.pages.length - 1}>
            <ChevronRight />
          </IconButton>
        </div>
      )}

      <Sep />
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={p.view}
        onValueChange={(v) => v && p.onView(v as ViewMode)}
        aria-label="View"
        className="ml-auto shrink-0 rounded-full bg-canvas p-0.5 sm:ml-0 *:data-[slot=toggle-group-item]:rounded-full *:data-[slot=toggle-group-item]:border-0 *:data-[slot=toggle-group-item]:px-2.5 *:data-[slot=toggle-group-item]:text-[12.5px] sm:*:data-[slot=toggle-group-item]:px-3 *:data-[state=on]:bg-primary *:data-[state=on]:text-primary-foreground"
      >
        <ToggleGroupItem value="edited">Edited</ToggleGroupItem>
        <ToggleGroupItem value="original">Original</ToggleGroupItem>
        <ToggleGroupItem value="side-by-side" aria-label="Side by side">
          <span className="md:hidden">Both</span>
          <span className="hidden md:inline">Side by side</span>
        </ToggleGroupItem>
      </ToggleGroup>

      {/* Zoom: inline from sm up. */}
      <div className="hidden items-center sm:flex">
        <Sep />
        <IconButton label="Zoom out" onClick={zoomOut}>
          <Minus />
        </IconButton>
        <span className="type-num w-12 shrink-0 text-center text-[12.5px] text-muted-foreground" aria-live="polite">
          {Math.round(p.zoom * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={zoomIn}>
          <Plus />
        </IconButton>
        <IconButton label="Fit page width" onClick={p.onFit}>
          <Maximize2 />
        </IconButton>
      </div>

      {/* Text boxes toggle: inline from md up (in the menu below that). */}
      <div className="hidden shrink-0 items-center gap-2 md:flex">
        <Sep />
        <Switch id="show-boxes" checked={p.showOverlays} onCheckedChange={p.onToggleOverlays} />
        <Label htmlFor="show-boxes" className="text-[12.5px] font-medium whitespace-nowrap text-muted-foreground">
          Text boxes
        </Label>
      </div>

      {/* Overflow menu: whatever is hidden at the current width. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More view options" className="md:hidden">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <div className="contents sm:hidden">
            <DropdownMenuItem onSelect={(e) => (e.preventDefault(), zoomIn())}>
              <Plus /> Zoom in
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => (e.preventDefault(), zoomOut())}>
              <Minus /> Zoom out
              <span className="type-num ml-auto text-[12px] text-muted-foreground">{Math.round(p.zoom * 100)}%</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onFit}>
              <Maximize2 /> Fit page width
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </div>
          <DropdownMenuItem onSelect={() => p.onToggleOverlays(!p.showOverlays)}>
            <Check className={p.showOverlays ? 'opacity-100' : 'opacity-0'} /> Show text boxes
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="ml-auto hidden shrink-0 pl-3 text-[12.5px] whitespace-nowrap text-muted-foreground md:inline" aria-live="polite">
        {p.status}
      </span>
    </div>
  );
}
