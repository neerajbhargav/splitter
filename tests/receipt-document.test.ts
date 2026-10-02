import {test} from 'node:test';import assert from 'node:assert/strict';
import {readReceiptPdf,pdfTextToLines,usablePdfReceiptText,receiptPdfScale,pdfReceiptError,RECEIPT_PDF_MAX_PIXELS,RECEIPT_PDF_MAX_DIMENSION,RECEIPT_DOCUMENT_MAX_BYTES,type ReceiptPdfApi,type ReceiptPdfPage,type PdfTextToken} from '../src/lib/receipt-document.ts';
import {parseReceipt} from '../src/lib/receipt.ts';
const token=(str:string,x:number,y:number):PdfTextToken=>({str,transform:[1,0,0,1,x,y]});
const receipt=[token('TEST MARKET',10,100),token('2026-09-29',10,80),token('TOTAL',10,60),token('33.00',160,60)];
function fixture(pages:PdfTextToken[][],renderGate?:Promise<unknown>){
 let destroyed=0,renders=0,cancels=0,cleanups=0;const visited:number[]=[];const canvases:HTMLCanvasElement[]=[];
 const api:ReceiptPdfApi={GlobalWorkerOptions:{workerSrc:''},getDocument:()=>({promise:Promise.resolve({numPages:pages.length,getPage:async(n)=>{visited.push(n);const page:ReceiptPdfPage={getTextContent:async()=>({items:pages[n-1]}),getViewport:({scale})=>({width:800*scale,height:1200*scale}),render:()=>{renders++;return{promise:renderGate??Promise.resolve(),cancel:()=>{cancels++;}};},cleanup:()=>{cleanups++;}};return page;}}),destroy:async()=>{destroyed++;}})};
 return{api,visited,canvases,makeCanvas:()=>{const c={width:0,height:0} as HTMLCanvasElement;canvases.push(c);return c;},stats:()=>({destroyed,renders,cancels,cleanups})};
}
test('PDF text respects rows and sorts amounts next to total labels',()=>{
 assert.equal(pdfTextToLines([receipt[3],receipt[0],receipt[2],receipt[1]]),'TEST MARKET\n2026-09-29\nTOTAL 33.00');
 assert.equal(pdfTextToLines([{str:'TOTAL',hasEOL:true},{str:'33.00'}]),'TOTAL\n33.00');
 assert.equal(usablePdfReceiptText('TEST MARKET\nTOTAL 33.00'),true);
 assert.equal(usablePdfReceiptText('TEST MARKET\n2026-09-29'),false);
});
test('PDF canvas dimensions remain within memory budget for huge pages',()=>{
 for(const[w,h]of[[800,1200],[20000,30000],[400,12000]]){const scale=receiptPdfScale(w,h);assert.ok(Math.floor(w*scale)*Math.floor(h*scale)<=RECEIPT_PDF_MAX_PIXELS);assert.ok(Math.max(w,h)*scale<=RECEIPT_PDF_MAX_DIMENSION);}
 assert.throws(()=>receiptPdfScale(0,500),/invalid dimensions/);
});
test('selectable text PDF skips OCR and destroys the local PDF task',async()=>{
 const f=fixture([receipt]);let ocr=0;
 const result=await readReceiptPdf(new Blob(['synthetic']),{signal:new AbortController().signal,loadPdf:async()=>f.api,makeCanvas:f.makeCanvas,recognize:async()=>{ocr++;return '';}});
 assert.equal(ocr,0);assert.equal(f.stats().renders,0);assert.equal(f.stats().destroyed,1);assert.equal(f.stats().cleanups,1);assert.equal(f.api.GlobalWorkerOptions.workerSrc,'/pdf.worker.min.mjs');assert.equal(parseReceipt(result.text).amount_cents,3300);assert.equal(result.complete,true);
});
test('scanned PDF pages render sequentially and release every canvas',async()=>{
 const f=fixture([[],[]]);let ocr=0;
 const result=await readReceiptPdf(new Blob(['synthetic']),{signal:new AbortController().signal,loadPdf:async()=>f.api,makeCanvas:f.makeCanvas,recognize:async(canvas)=>{assert.ok(canvas.width*canvas.height<=RECEIPT_PDF_MAX_PIXELS);ocr++;return `TEST MARKET\nTOTAL ${ocr===1?'33.00':'40.00'}`;}});
 assert.equal(ocr,2);assert.equal(f.stats().renders,2);assert.equal(f.stats().cleanups,2);assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));assert.equal(parseReceipt(result.text).amount_cents,undefined);assert.equal(f.stats().destroyed,1);
});
test('long PDFs inspect only five pages and flag incomplete totals',async()=>{
 const f=fixture(Array.from({length:8},()=>receipt));
 const r=await readReceiptPdf(new Blob(['synthetic']),{signal:new AbortController().signal,loadPdf:async()=>f.api,recognize:async()=>''});
 assert.equal(r.pagesRead,5);assert.equal(r.totalPages,8);assert.equal(r.complete,false);assert.ok(r.warnings[0].includes('first 5 of 8'));assert.deepEqual(f.visited,[1,2,3,4,5]);
});
test('canceling OCR destroys PDF and releases canvas',async()=>{
 const c=new AbortController(),f=fixture([[]]);
 await assert.rejects(readReceiptPdf(new Blob(['synthetic']),{signal:c.signal,loadPdf:async()=>f.api,makeCanvas:f.makeCanvas,recognize:async()=>{c.abort();return 'TOTAL 33.00';}}),{name:'AbortError'});
 assert.equal(f.stats().destroyed,1);assert.ok(f.canvases.every(c=>c.width===0));assert.equal(f.stats().cleanups,1);
});
test('pre-canceled and oversized PDFs never load PDF.js',async()=>{
 let loads=0;const loader=async()=>{loads++;return fixture([]).api;};const c=new AbortController();c.abort();
 await assert.rejects(readReceiptPdf(new Blob(['synthetic']),{signal:c.signal,loadPdf:loader,recognize:async()=>''}),{name:'AbortError'});
 await assert.rejects(readReceiptPdf(new Blob([new Uint8Array(RECEIPT_DOCUMENT_MAX_BYTES+1)]),{signal:new AbortController().signal,loadPdf:loader,recognize:async()=>''}),/15 MB/);assert.equal(loads,0);
});
test('encrypted and invalid PDF errors explain usable next steps',async()=>{
 const f=fixture([]);f.api.getDocument=()=>({promise:Promise.reject(Object.assign(new Error('Password required'),{name:'PasswordException'})),destroy:async()=>{}});
 await assert.rejects(readReceiptPdf(new Blob(['synthetic']),{signal:new AbortController().signal,loadPdf:async()=>f.api,recognize:async()=>''}),/password-protected/);
 assert.match(pdfReceiptError({name:'InvalidPDFException'}).message,/another PDF/);
});
test('canceling an in-flight render returns promptly even before render promise settles',async()=>{
 const c=new AbortController();const pending=new Promise<unknown>(()=>{});const f=fixture([[]],pending);
 const oldGetDocument=f.api.getDocument;
 f.api.getDocument=(options)=>{const task=oldGetDocument(options);return {...task,promise:task.promise.then(doc=>({...doc,getPage:async(n)=>{const p=await doc.getPage(n);const oldRender=p.render;p.render=(opts)=>{const r=oldRender(opts);queueMicrotask(()=>c.abort());return r;};return p;}}))};};
 await assert.rejects(readReceiptPdf(new Blob(['synthetic']),{signal:c.signal,loadPdf:async()=>f.api,makeCanvas:f.makeCanvas,recognize:async()=>''}),{name:'AbortError'});
 assert.equal(f.stats().destroyed,1);assert.ok(f.stats().cancels>=1);assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));
});
