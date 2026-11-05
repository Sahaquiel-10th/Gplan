import {useEffect,useId,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';

/** Native modal: focus trap, Escape and focus return come from the browser. */
export function FinanceDialog({title,context,busy=false,onClose,children}:{title:string;context?:string;busy?:boolean;onClose:()=>void;children:ReactNode}){
 const ref=useRef<HTMLDialogElement>(null),returnFocus=useRef(document.activeElement as HTMLElement|null),titleId=useId();
 useEffect(()=>{const dialog=ref.current!;const overflow=document.body.style.overflow;dialog.showModal();document.body.style.overflow='hidden';return()=>{dialog.close();document.body.style.overflow=overflow;queueMicrotask(()=>{if(returnFocus.current?.isConnected)returnFocus.current.focus({preventScroll:true});});};},[]);
 return <dialog ref={ref} className="finance-dialog finance-panel" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <header className="finance-dialog-heading"><div><small>银行与支付宝{context?' / '+context:''}</small><h3 id={titleId}>{title}</h3></div><button type="button" className="secondary" disabled={busy} onClick={onClose} aria-label="关闭弹窗，返回账户清单"><X size={18} aria-hidden="true"/>关闭</button></header>
  <div className="finance-dialog-body">{children}</div>
 </dialog>;
}
