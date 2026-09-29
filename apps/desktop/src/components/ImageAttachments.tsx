import {useEffect, useRef, useState} from 'react';
import {ImagePlus, X} from 'lucide-react';
import type {PromptImage} from '@industrial-agent-harness/viewer-builtin/api';

const maxImage = 5 * 1024 * 1024;
const maxTotal = 10 * 1024 * 1024;
const supported = ['image/png', 'image/jpeg', 'image/webp'];
function readImage(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({id: crypto.randomUUID(), name: file.name.slice(0, 200) || 'Pasted image.png', dataUrl: String(reader.result)});
    reader.onerror = () => reject(Error(`Unable to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
export function useImageAttachments(projectId: string | null) {
  const [images, setImages] = useState<PromptImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<PromptImage[]>([]);
  const generation = useRef(0);
  const reading = useRef(false);
  function clear() {generation.current++; reading.current = false; current.current = []; setImages([]); setLoading(false); setError('');}
  useEffect(() => {clear(); return () => {generation.current++;};}, [projectId]);
  async function addFiles(files: File[]) {
    if (reading.current) return;
    if (!projectId) {setError('Choose a project before attaching images.'); return;}
    const existing = current.current;
    if (!files.length) return;
    if (existing.length + files.length > 4) {setError('Attach up to 4 images.'); return;}
    if (files.some(file => !supported.includes(file.type))) {setError('Supported image formats: PNG, JPEG and WebP.'); return;}
    if (files.some(file => file.size > maxImage) || files.reduce((sum, file) => sum + file.size, existing.reduce((sum, image) => sum + (image.sizeBytes || 0), 0)) > maxTotal) {setError('Images must be at most 5 MB each and 10 MB combined.'); return;}
    reading.current = true; setLoading(true); setError('');
    const version = ++generation.current;
    try {
      const additions = await Promise.all(files.map(readImage));
      if (version !== generation.current) return;
      const checked = await window.viewerHost!.validateImages({projectId, images: [...existing, ...additions]});
      // Bound the raster headers in main before Chromium fully decodes, including WebP.
      for (let index = 0; index < files.length; index++) {
        const bitmap = await createImageBitmap(files[index]);
        const image = checked[existing.length + index];
        try {if (bitmap.width * bitmap.height !== image.width! * image.height! || bitmap.width > 8192 || bitmap.height > 8192) throw Error('This image is corrupt or cannot be decoded.');}
        finally {bitmap.close();}
      }
      if (version === generation.current) {current.current = checked; setImages(checked);}
    } catch (reason) {if (version === generation.current) setError(String(reason));}
    finally {if (version === generation.current) {reading.current = false; setLoading(false);}}
  }
  function restore(value: PromptImage[]) {generation.current++; reading.current = false; current.current = value; setImages(value); setLoading(false);}
  function remove(id: string) {current.current = current.current.filter(image => image.id !== id); setImages(current.current); setError('');}
  return {images, loading, error, input, addFiles, clear, remove, restore};
}
export function ImageThumbnails({images, onRemove, disabled}: {images: PromptImage[]; onRemove?: (id: string) => void; disabled?: boolean}) {
  return <div className="ia-image-attachments">{images.map(image => <figure key={image.id}><img src={image.dataUrl} alt={image.name}/><figcaption title={image.name}>{image.name}</figcaption>{onRemove && <button aria-label={`Remove image ${image.name}`} disabled={disabled} onClick={() => onRemove(image.id)}><X size={12}/></button>}</figure>)}</div>;
}
export function ImageAttachButton({attachments, disabled}: {attachments: ReturnType<typeof useImageAttachments>; disabled: boolean}) {
  return <><input ref={attachments.input} className="ia-image-file-input" type="file" aria-label="Image attachment files" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={event => {const files = Array.from(event.target.files || []); event.target.value = ''; void attachments.addFiles(files);}}/><button aria-label="Attach images" title="Attach images (or paste / drop a screenshot)" disabled={disabled} onClick={() => attachments.input.current?.click()}><ImagePlus size={16}/></button></>;
}
