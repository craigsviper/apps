import { useState, useRef, useEffect, useCallback } from 'react';
import { compressImage } from '../../utils/imageCompress';
import { useStore } from '../../store';
import type { SweepJobSite, SweepFile, SiteMapPin } from '../../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ── Helpers ──────────────────────────────────────────────────────────────────
const SITE_TYPE_COLORS: Record<string,string> = {
  CBD:'bg-purple-100 text-purple-700', Industrial:'bg-blue-100 text-blue-700',
  Residential:'bg-green-100 text-green-700', Rural:'bg-lime-100 text-lime-700',
  Local:'bg-orange-100 text-orange-700',
};
function siteTypeColor(t:string){ return SITE_TYPE_COLORS[t]||'bg-gray-100 text-gray-600'; }
const FILE_TYPE_COLORS: Record<string,string> = {
  TMP:'bg-blue-100 text-blue-700', JSA:'bg-red-100 text-red-700',
  Permit:'bg-yellow-100 text-yellow-700', 'Tip Site':'bg-gray-100 text-gray-700',
  'Water Point':'bg-cyan-100 text-cyan-700', Photo:'bg-green-100 text-green-700',
  Report:'bg-purple-100 text-purple-700', Other:'bg-gray-100 text-gray-600',
};
function fileTypeColor(t:string){ return FILE_TYPE_COLORS[t]||'bg-gray-100 text-gray-600'; }
function getFileIcon(mime:string, name:string):string{
  if(mime.startsWith('image/')||/\.(jpg|jpeg|png|gif|webp)$/i.test(name))return'🖼️';
  if(mime==='application/pdf'||name.endsWith('.pdf'))return'📕';
  if(/\.(doc|docx)$/i.test(name)||mime.includes('word'))return'📝';
  if(/\.(xls|xlsx|csv)$/i.test(name)||mime.includes('spreadsheet'))return'📊';
  return'📎';
}
function formatBytes(b:number):string{
  if(!b)return'—'; if(b<1024)return`${b} B`;
  if(b<1048576)return`${(b/1024).toFixed(1)} KB`;
  return`${(b/1048576).toFixed(1)} MB`;
}
function formatDate(iso:string):string{
  if(!iso)return''; try{return new Date(iso).toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric'});}catch{return iso.slice(0,10);}
}
function dataUrlToBlob(dataUrl:string):Blob|null{
  try{
    const[header,b64]=dataUrl.split(',');
    const mime=header.match(/:(.*?);/)?.[1]||'application/octet-stream';
    const bytes=atob(b64);
    const arr=new Uint8Array(bytes.length);
    for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);
    return new Blob([arr],{type:mime});
  }catch{return null;}
}
function openFile(file:SweepFile){
  if(!file.data){alert('File data is missing. Try re-attaching the file.');return;}
  const mime=(file.mimeType||'').toLowerCase();
  const blob=dataUrlToBlob(file.data);
  const blobUrl=blob?URL.createObjectURL(blob):null;
  if(mime.startsWith('image/')){
    // Open images in a proper image viewer window — never use iframe for images
    const w=window.open('','_blank');
    if(w){
      w.document.write(`<!DOCTYPE html><html><head><title>${file.name}</title><style>body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${file.data}" alt="${file.name}"></body></html>`);
      w.document.close();
      return;
    }
  }
  if(blobUrl){
    // PDFs and text files: open blob URL (no data URL size limit)
    const w=window.open(blobUrl,'_blank');
    if(w){setTimeout(()=>URL.revokeObjectURL(blobUrl),30000);return;}
  }
  // Fallback: download
  const a=document.createElement('a');
  a.href=file.data;a.download=file.name;
  document.body.appendChild(a);a.click();
  setTimeout(()=>document.body.removeChild(a),300);
}

// ── Pin type config (defaults — overridden by SW Categories → Job Sites Map & Pins) ──
const DEFAULT_PIN_TYPES = [
  {type:'💧 Water Point',  color:'#0891b2'},
  {type:'🗑️ Tip Site',     color:'#6b7280'},
  {type:'⚠️ Hazard',       color:'#dc2626'},
  {type:'🚪 Access Point', color:'#059669'},
  {type:'📍 Other',        color:'#7c3aed'},
];
const PIN_COLOR_PALETTE = ['#0891b2','#6b7280','#dc2626','#059669','#7c3aed','#d97706','#be185d','#065f46','#1e40af','#92400e'];
function buildPinTypes(catItems:string[]):{type:string;color:string}[]{
  if(!catItems||catItems.length===0)return DEFAULT_PIN_TYPES;
  return catItems.map((name,i)=>({type:name,color:PIN_COLOR_PALETTE[i%PIN_COLOR_PALETTE.length]}));
}
function pinColorFromList(t:string,list:{type:string;color:string}[]):string{
  const p=list.find(x=>x.type===t);
  return p?.color||'#6366f1';
}

// ── Leaflet map component with click-to-add pins ──────────────────────────────
function SiteMap({
  pins, onPinsChange, center, zoom, onViewChange, pinTypes,
}:{
  pins:SiteMapPin[];
  onPinsChange:(pins:SiteMapPin[])=>void;
  center?:[number,number];
  zoom?:number;
  onViewChange:(center:[number,number],zoom:number)=>void;
  pinTypes:{type:string;color:string}[];
}){
  const containerRef=useRef<HTMLDivElement>(null);
  const mapRef=useRef<any>(null);
  const markersRef=useRef<any[]>([]);
  const pinsRef=useRef(pins);
  useEffect(()=>{pinsRef.current=pins;},[pins]);

  // City search
  const [citySearch,setCitySearch]=useState('');
  const [citySearching,setCitySearching]=useState(false);
  const [cityError,setCityError]=useState('');
  const [addMode,setAddMode]=useState(false);
  const [newPinType,setNewPinType]=useState('💧 Water Point');
  const [newPinLabel,setNewPinLabel]=useState('');

  const searchCity=async()=>{
    const q=citySearch.trim(); if(!q||!mapRef.current)return;
    setCitySearching(true);setCityError('');
    try{
      const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,{headers:{'Accept-Language':'en'}});
      const res=await r.json();
      if(res.length>0){mapRef.current.setView([parseFloat(res[0].lat),parseFloat(res[0].lon)],15,{animate:true});}
      else setCityError(`"${q}" not found`);
    }catch{setCityError('Search unavailable');}
    finally{setCitySearching(false);}
  };

  useEffect(()=>{
    if(!containerRef.current)return;
    if(mapRef.current){try{mapRef.current.remove();}catch{}mapRef.current=null;}
    const initCenter:any=center&&center[0]?center:[-37.7826,175.2528];
    const map=L.map(containerRef.current,{zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120, attributionControl:false,renderer:L.canvas({tolerance:8})}).setView(initCenter,zoom||14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
    mapRef.current=map;
    setTimeout(()=>{try{map.invalidateSize({animate:false});}catch{}},100);

    map.on('moveend zoomend',()=>{
      const c=map.getCenter();
      onViewChange([c.lat,c.lng],map.getZoom());
    });

    const rebuildMarkers=()=>{
      markersRef.current.forEach(m=>m.remove());markersRef.current=[];
      pinsRef.current.forEach((pin,i)=>{
        const col=pinColorFromList(pin.pinType,pinTypes);
        const icon=L.divIcon({
          className:'',
          html:`<div style="display:flex;flex-direction:column;align-items:center;"><div style="width:28px;height:28px;border-radius:50%;background:${col};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:13px;">${pin.pinType.split(' ')[0]}</div><div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid ${col};margin-top:-1px;"></div></div>`,
          iconSize:[28,36],iconAnchor:[14,36],
        });
        const m=L.marker([pin.lat,pin.lng],{icon,draggable:true,zIndexOffset:500}).addTo(map);
        const popEl=document.createElement('div');
        popEl.style.cssText='padding:4px;min-width:160px;';
        const notesHtml=pin.notes?`<p style="font-size:10px;color:#ea580c;background:#fff7ed;border-radius:4px;padding:3px 6px;margin:0 0 6px;border-left:3px solid #fb923c;">💬 ${pin.notes}</p>`:'';
        popEl.innerHTML=`<p style="font-size:12px;font-weight:700;margin:0 0 2px;">${pin.pinType}</p><p style="font-size:11px;margin:0 0 5px;color:#374151;">${pin.label||'—'}</p>${notesHtml}`;
        const delBtn=document.createElement('button');
        delBtn.textContent='🗑️ Delete Pin';
        delBtn.style.cssText='background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;width:100%;';
        delBtn.addEventListener('click',()=>{
          const updated=pinsRef.current.filter((_,pi)=>pi!==i);
          pinsRef.current=updated;onPinsChange(updated);map.closePopup();rebuildMarkers();
        });
        popEl.appendChild(delBtn);
        m.bindPopup(popEl,{maxWidth:200,closeButton:true});
        m.on('dragend',()=>{
          const ll=m.getLatLng();
          const updated=pinsRef.current.map((p,pi)=>pi===i?{...p,lat:ll.lat,lng:ll.lng}:p);
          pinsRef.current=updated;onPinsChange(updated);
        });
        markersRef.current.push(m);
      });
    };
    rebuildMarkers();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (containerRef.current as any).__rebuildMarkers=rebuildMarkers;

    return()=>{try{map.remove();}catch{}mapRef.current=null;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(()=>{
    pinsRef.current=pins;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (containerRef.current as any)?.__rebuildMarkers?.();
  },[pins]);

  // Refs keep volatile values current so the stable Leaflet handler never needs re-registering
  const newPinLabelRef=useRef(newPinLabel);
  const newPinTypeRef=useRef(newPinType);
  const pinTypesRef=useRef(pinTypes);
  const addModeRef=useRef(addMode);
  useEffect(()=>{newPinLabelRef.current=newPinLabel;},[newPinLabel]);
  useEffect(()=>{newPinTypeRef.current=newPinType;},[newPinType]);
  useEffect(()=>{pinTypesRef.current=pinTypes;},[pinTypes]);
  useEffect(()=>{addModeRef.current=addMode;},[addMode]);

  // Single stable click handler — same reference every render so Leaflet .off() works correctly
  const stableClickHandler=useRef((e:any)=>{
    if(!addModeRef.current)return;
    const label=newPinLabelRef.current||newPinTypeRef.current;
    const ptype=newPinTypeRef.current;
    const newPin:SiteMapPin={
      id:`pin-${Date.now()}`,
      lat:e.latlng.lat,lng:e.latlng.lng,
      label,
      pinType:ptype,
      color:pinColorFromList(ptype,pinTypesRef.current),
      notes:'',
    };
    const updated=[...pinsRef.current,newPin];
    pinsRef.current=updated;onPinsChange(updated);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (containerRef.current as any).__rebuildMarkers?.();
  });

  // Only toggle the listener when addMode changes — label/type changes go through refs above
  useEffect(()=>{
    if(!mapRef.current)return;
    if(addMode){
      mapRef.current.on('click',stableClickHandler.current);
      mapRef.current.getContainer().style.cursor='crosshair';
    } else {
      mapRef.current.off('click',stableClickHandler.current);
      mapRef.current.getContainer().style.cursor='grab';
    }
    return()=>{mapRef.current?.off('click',stableClickHandler.current);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[addMode]);

  // Keep newPinType valid when pinTypes list changes
  useEffect(()=>{
    if(pinTypes.length>0&&!pinTypes.find(p=>p.type===newPinType)){
      setNewPinType(pinTypes[0].type);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pinTypes]);

  return(
    <div className="space-y-2">
      {/* Search */}
      <div className="flex gap-2">
        <input type="text" className="input-field flex-1 text-sm"
          placeholder="🔍 Search town or city (e.g. Otorohanga NZ)"
          value={citySearch}
          onChange={e=>{setCitySearch(e.target.value);setCityError('');}}
          onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();searchCity();}}}/>
        <button onClick={searchCity} disabled={citySearching||!citySearch.trim()}
          className="btn-secondary text-sm px-3 shrink-0 disabled:opacity-50">{citySearching?'⏳':'🔍 Go'}</button>
      </div>
      {cityError&&<p className="text-xs text-red-500">{cityError}</p>}

      {/* Pin controls */}
      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={()=>setAddMode(p=>!p)}
          className={`text-sm px-3 py-1.5 rounded-lg font-medium border transition ${addMode?'bg-indigo-600 text-white border-indigo-600':'bg-white text-gray-700 border-gray-300 hover:border-indigo-400'}`}>
          {addMode?'✕ Stop Adding Pins':'📍 Add Pin'}
        </button>
        {addMode&&(
          <>
            <select className="input-field text-sm py-1.5 w-auto" value={newPinType}
              onChange={e=>setNewPinType(e.target.value)}>
              {pinTypes.map(p=><option key={p.type} value={p.type}>{p.type}</option>)}
            </select>
            <input type="text" className="input-field text-sm py-1.5 flex-1 min-w-[120px]" placeholder="Label (optional)"
              value={newPinLabel} onChange={e=>setNewPinLabel(e.target.value)}/>
            <span className="text-xs text-indigo-600 font-medium whitespace-nowrap">↙ Click map to place</span>
          </>
        )}
      </div>

      {/* Map */}
      <div ref={containerRef} className="w-full rounded-xl border border-gray-200 shadow-sm" style={{height:380}}/>

      {/* Pin list */}
      {pins.length>0&&(
        <div className="space-y-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{pins.length} Pin{pins.length!==1?'s':''}</p>
          {pins.map((pin,pi)=>(
            <div key={pin.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 p-2 text-xs">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-sm shrink-0"
                  style={{backgroundColor:pin.color+'22',border:`2px solid ${pin.color}`}}>
                  {pin.pinType.split(' ')[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-gray-800">{pin.label}</span>
                  <span className="text-gray-400 ml-1">· {pin.pinType}</span>
                </div>
                <span className="text-gray-300 shrink-0">{pin.lat.toFixed(4)},{pin.lng.toFixed(4)}</span>
                <button
                  onClick={()=>{
                    const updated=pins.map((p,i)=>i===pi?{...p,_editingNote:!(p as any)._editingNote}:p);
                    onPinsChange(updated);
                  }}
                  className="shrink-0 text-gray-400 hover:text-orange-500 transition" title="Add/Edit comment">
                  💬
                </button>
              </div>
              {/* Comment field */}
              <div className="px-2 pb-2">
                <input
                  type="text"
                  className="w-full text-xs border border-dashed border-gray-300 rounded px-2 py-1 bg-gray-50 focus:outline-none focus:border-orange-400 focus:bg-white placeholder-gray-400"
                  placeholder="Add a comment or note for this pin…"
                  value={pin.notes||''}
                  onChange={e=>{
                    const updated=pins.map((p,i)=>i===pi?{...p,notes:e.target.value}:p);
                    onPinsChange(updated);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── File row components ───────────────────────────────────────────────────────
function FileRow({file,onDelete}:{file:SweepFile;onDelete:()=>void}){
  const badge=fileTypeColor(file.fileType); const icon=getFileIcon(file.mimeType||'',file.name);
  return(
    <div className="flex items-center gap-2 p-2.5 bg-white border border-gray-200 rounded-lg group hover:border-orange-300 hover:bg-orange-50 transition-colors">
      <span className="text-xl shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <button onClick={()=>openFile(file)} className="text-sm font-medium text-blue-700 hover:underline text-left truncate block">{file.name}</button>
        <div className="flex gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badge}`}>{file.fileType}</span>
          <span className="text-xs text-gray-400">{formatBytes(file.sizeBytes)}</span>
          {file.createdAt&&<span className="text-xs text-gray-400">{formatDate(file.createdAt)}</span>}
        </div>
      </div>
      <button onClick={onDelete} className="text-red-400 hover:text-red-600 text-lg px-1">✕</button>
    </div>
  );
}
type PendingFile={name:string;fileType:string;data:string;mimeType:string;sizeBytes:number;linkedTo:'site'};
function PendingFileRow({file,onRemove}:{file:PendingFile;onRemove:()=>void}){
  const badge=fileTypeColor(file.fileType); const icon=getFileIcon(file.mimeType,file.name);
  return(
    <div className="flex items-center gap-2 p-2.5 bg-orange-50 border border-orange-200 rounded-lg">
      <span className="text-xl shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
        <div className="flex gap-2 mt-0.5">
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badge}`}>{file.fileType}</span>
          <span className="text-xs text-gray-400">{formatBytes(file.sizeBytes)}</span>
          <span className="text-xs text-orange-500 font-medium">⏳ Pending</span>
        </div>
      </div>
      <button onClick={onRemove} className="text-red-400 hover:text-red-600 text-lg px-1">✕</button>
    </div>
  );
}

// ── SitesTab ──────────────────────────────────────────────────────────────────
const EMPTY_SITE:Omit<SweepJobSite,'id'|'createdAt'|'updatedAt'>={
  name:'',siteType:'',clientId:'',address:'',notes:'',fileIds:[],areaIds:[],mapPins:[],
};

function SitesTab(){
  const{data,addSweepJobSite,updateSweepJobSite,deleteSweepJobSite,addSweepFile,deleteSweepFile}=useStore();
  const sites=data.sweepJobSites||[];
  const clients=data.sweepClients||[];
  const files=data.sweepFiles||[];
  const cats=data.sweepCategories||[];
  const siteTypeCat=cats.find(c=>c.categoryType==='site_type');
  const fileAttachCat=cats.find(c=>c.categoryType==='file_attachment');
  const mapPinCat=cats.find(c=>c.categoryType==='job_site_map_pin');
  const siteTypeItems=siteTypeCat?.items?.map(i=>i.name)??['CBD','Industrial','Residential','Rural','Local'];
  const fileTypeItems=fileAttachCat?.items?.map(i=>i.name)??['TMP','JSA','Permit','Tip Site','Water Point','Photo','Report','Other'];
  const pinTypeItems=mapPinCat?.items?.map(i=>i.name)??[];
  const pinTypes=buildPinTypes(pinTypeItems);

  const[showForm,setShowForm]=useState(false);
  const[editing,setEditing]=useState<SweepJobSite|null>(null);
  const[siteMsg,setSiteMsg]=useState('');
  const[form,setForm]=useState<Omit<SweepJobSite,'id'|'createdAt'|'updatedAt'>>(EMPTY_SITE);
  const[search,setSearch]=useState('');
  const[filterType,setFilterType]=useState('');
  const fileInputRef=useRef<HTMLInputElement>(null);
  const[pendingFiles,setPendingFiles]=useState<PendingFile[]>([]);
  const[newFileType,setNewFileType]=useState('TMP');
  const[expandedSite,setExpandedSite]=useState<string|null>(null);
  const[activeFormTab,setActiveFormTab]=useState<'info'|'map'|'files'>('info');

  const siteFiles=(siteId:string)=>files.filter(f=>f.linkedId===siteId);
  const filtered=sites.filter(s=>{
    const matchSearch=s.name.toLowerCase().includes(search.toLowerCase())||s.address.toLowerCase().includes(search.toLowerCase());
    const matchType=!filterType||s.siteType===filterType;
    return matchSearch&&matchType;
  });

  const openNew=()=>{
    setEditing(null);setForm(EMPTY_SITE);setPendingFiles([]);
    setActiveFormTab('info');setShowForm(true);
  };
  const openEdit=(s:SweepJobSite)=>{
    setEditing(s);setForm({name:s.name,siteType:s.siteType,clientId:s.clientId,
      address:s.address,notes:s.notes,fileIds:[...s.fileIds],areaIds:[...s.areaIds],
      mapPins:[...(s.mapPins||[])],mapCenter:s.mapCenter,mapZoom:s.mapZoom});
    setPendingFiles([]);setActiveFormTab('info');setShowForm(true);
  };
  const saveSite=()=>{
    if(!form.name.trim())return;
    if(editing){
      // Existing site — use returned file id from store (store generates its own uid)
      const newIds:string[]=[];
      for(const pf of pendingFiles){
        const created=addSweepFile({name:pf.name,fileType:pf.fileType as SweepFile['fileType'],data:pf.data,mimeType:pf.mimeType,sizeBytes:pf.sizeBytes,linkedTo:'site',linkedId:editing.id});
        newIds.push(created.id);
      }
      updateSweepJobSite({...editing,...form,fileIds:[...form.fileIds,...newIds]});
    } else {
      // New site — create first to get real ID, then attach files using their store-generated ids
      const newSite=addSweepJobSite({...form,fileIds:[]});
      const newIds:string[]=[];
      for(const pf of pendingFiles){
        const created=addSweepFile({name:pf.name,fileType:pf.fileType as SweepFile['fileType'],data:pf.data,mimeType:pf.mimeType,sizeBytes:pf.sizeBytes,linkedTo:'site',linkedId:newSite.id});
        newIds.push(created.id);
      }
      if(newIds.length>0){
        updateSweepJobSite({...newSite,fileIds:newIds});
      }
      // Switch to edit mode so repeat saves update instead of creating duplicates
      setEditing({...newSite,fileIds:newIds.length>0?newIds:[]});
      setForm(prev=>({...prev,fileIds:newIds.length>0?newIds:[]}));
    }
    // Stay in modal — user can keep editing files, map pins etc.
    // For new sites, editing is now set so subsequent saves update instead of duplicating
    const flash = (m: string) => { setSiteMsg(m); setTimeout(() => setSiteMsg(''), 3500); };
    if(editing){
      flash('✅ Site saved — keep editing or close when done');
    } else {
      flash('✅ Site created — keep editing or close when done');
    }
    setPendingFiles([]);
  };

  const handleFileInput=useCallback((e:React.ChangeEvent<HTMLInputElement>)=>{
    const f=e.target.files?.[0];if(!f)return;
    const fileType=newFileType;
    const reader=new FileReader();
    reader.onload=async ev=>{
      const raw=ev.target?.result;
      if(typeof raw!=='string'||!raw){
        alert(`Could not read file "${f.name}". Please try again.`);
        return;
      }
      let data=raw;
      // Compress images to keep storage manageable and ensure they open correctly
      if(f.type.startsWith('image/')){
        try{ data=await compressImage(raw,1600,0.80); }catch{ data=raw; }
      }
      // Use compressed size for display
      const sizeBytes=Math.round(data.length*0.75); // base64 → bytes approx
      setPendingFiles(prev=>[...prev,{
        name:f.name,
        fileType,
        data,
        mimeType:f.type||'application/octet-stream',
        sizeBytes,
        linkedTo:'site'
      }]);
    };
    reader.onerror=()=>alert(`Failed to read file "${f.name}". The file may be corrupted or too large.`);
    reader.readAsDataURL(f);
    e.target.value='';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[newFileType]);

  return(
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2 flex-1 flex-wrap">
          <input className="input-field flex-1 min-w-0" placeholder="Search sites…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          <select className="input-field w-auto" value={filterType} onChange={e=>setFilterType(e.target.value)}>
            <option value="">All Types</option>
            {siteTypeItems.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <button onClick={openNew} className="btn-primary shrink-0">+ New Job Site</button>
      </div>

      {/* Site cards */}
      {filtered.length===0?(
        <div className="card text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">📌</div>
          <p className="font-medium text-gray-600">{search||filterType?'No sites match your search':'No job sites yet'}</p>
          {!search&&!filterType&&<button onClick={openNew} className="btn-primary mt-4">+ Create First Job Site</button>}
        </div>
      ):(
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map(site=>{
            const sf=siteFiles(site.id);
            const client=clients.find(c=>c.id===site.clientId);
            const isExpanded=expandedSite===site.id;
            const pinCount=(site.mapPins||[]).length;
            return(
              <div key={site.id} className="card space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-gray-900">{site.name}</h3>
                      {site.siteType&&<span className={`text-xs px-2 py-0.5 rounded-full font-medium ${siteTypeColor(site.siteType)}`}>{site.siteType}</span>}
                    </div>
                    {client&&<p className="text-xs text-gray-500 mt-0.5">🏢 {client.name}{client.company?` (${client.company})`:''}</p>}
                    {site.address&&<p className="text-xs text-gray-500">📍 {site.address}</p>}
                    <div className="flex gap-3 mt-1 text-xs text-gray-400 flex-wrap">
                      {sf.length>0&&<span>📎 {sf.length} file{sf.length!==1?'s':''}</span>}
                      {pinCount>0&&<span>📍 {pinCount} map pin{pinCount!==1?'s':''}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={()=>openEdit(site)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700" title="Edit">✏️</button>
                    <button onClick={()=>{if(confirm(`Delete "${site.name}"?`)){deleteSweepJobSite(site.id);}}} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600" title="Delete">🗑️</button>
                  </div>
                </div>

                {/* Map preview if has pins */}
                {pinCount>0&&(
                  <button onClick={()=>setExpandedSite(isExpanded?null:site.id)}
                    className="w-full text-xs text-indigo-600 hover:text-indigo-800 text-left font-medium">
                    {isExpanded?'▲ Hide map':'▼ Show map & pins'}
                  </button>
                )}
                {isExpanded&&pinCount>0&&(
                  <div className="rounded-xl overflow-hidden border border-gray-200">
                    <SiteMapReadOnly pins={site.mapPins||[]} center={site.mapCenter} zoom={site.mapZoom}/>
                  </div>
                )}

                {/* Files */}
                {sf.length>0&&(
                  <div className="space-y-1">
                    {sf.map(f=>(
                      <FileRow key={f.id} file={f} onDelete={()=>{if(confirm(`Delete "${f.name}"?`))deleteSweepFile(f.id);}}/>
                    ))}
                  </div>
                )}
                {site.notes&&<p className="text-xs text-gray-500 italic">{site.notes}</p>}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {showForm&&(
        <div className="modal-overlay">
          <div className="modal-content max-w-2xl p-6" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">{editing?'Edit Job Site':'New Job Site'}</h2>
              <button onClick={()=>{setShowForm(false);setEditing(null);setSiteMsg('');}} className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1 rounded hover:bg-gray-100">✕</button>
            </div>
            {siteMsg&&<div className={`mb-3 px-3 py-2 rounded-lg text-sm font-medium ${siteMsg.startsWith('✅')?'bg-emerald-50 text-emerald-700 border border-emerald-200':'bg-amber-50 text-amber-700 border border-amber-200'}`}>{siteMsg}</div>}

            {/* Form tabs */}
            <div className="flex gap-1 bg-gray-100 p-1 rounded-xl mb-4">
              {(['info','map','files'] as const).map(t=>(
                <button key={t} onClick={()=>setActiveFormTab(t)}
                  className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-lg transition capitalize ${activeFormTab===t?'bg-white text-indigo-600 shadow-sm':'text-gray-600 hover:text-gray-900'}`}>
                  {t==='info'?'📋 Info':t==='map'?`🗺️ Map & Pins (${(form.mapPins||[]).length})`:'📎 Files'}
                </button>
              ))}
            </div>

            {activeFormTab==='info'&&(
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Site Name *</label>
                  <input className="input-field" autoFocus value={form.name}
                    onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Otorohanga CBD"/>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Site Type</label>
                    <select className="input-field" value={form.siteType} onChange={e=>setForm(p=>({...p,siteType:e.target.value}))}>
                      <option value="">— Select —</option>
                      {siteTypeItems.map(t=><option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
                    <select className="input-field" value={form.clientId} onChange={e=>setForm(p=>({...p,clientId:e.target.value}))}>
                      <option value="">No client</option>
                      {clients.map(c=><option key={c.id} value={c.id}>{c.name}{c.company?` (${c.company})`:''}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                  <input className="input-field" value={form.address}
                    onChange={e=>setForm(p=>({...p,address:e.target.value}))} placeholder="Street address or location description"/>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea className="input-field" rows={3} value={form.notes}
                    onChange={e=>setForm(p=>({...p,notes:e.target.value}))} placeholder="Any notes about this site"/>
                </div>
              </div>
            )}

            {activeFormTab==='map'&&(
              <div className="space-y-3">
                <p className="text-sm text-gray-500">Add pins for key locations like water pick-up points, tip sites, or hazards. Click a pin to edit or delete it.</p>
                <SiteMap
                  pins={form.mapPins||[]}
                  onPinsChange={pins=>setForm(p=>({...p,mapPins:pins}))}
                  center={form.mapCenter}
                  zoom={form.mapZoom}
                  onViewChange={(center,zoom)=>setForm(p=>({...p,mapCenter:center,mapZoom:zoom}))}
                  pinTypes={pinTypes}
                />
              </div>
            )}

            {activeFormTab==='files'&&(
              <div className="space-y-3">
                {/* Existing files */}
                {editing&&siteFiles(editing.id).map(f=>(
                  <FileRow key={f.id} file={f} onDelete={()=>{if(confirm(`Delete "${f.name}"?`))deleteSweepFile(f.id);}}/>
                ))}
                {/* Pending files */}
                {pendingFiles.map((f,i)=>(
                  <PendingFileRow key={i} file={f} onRemove={()=>setPendingFiles(p=>p.filter((_,pi)=>pi!==i))}/>
                ))}
                {/* Add file */}
                <div className="flex gap-2 items-center pt-2">
                  <select className="input-field w-auto text-sm" value={newFileType} onChange={e=>setNewFileType(e.target.value)}>
                    {fileTypeItems.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={()=>fileInputRef.current?.click()} className="btn-secondary text-sm">📎 Attach File</button>
                  <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput}/>
                </div>
                {pendingFiles.length===0&&(!editing||siteFiles(editing.id).length===0)&&(
                  <p className="text-sm text-gray-400 text-center py-4">No files attached yet.</p>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-4 mt-4 border-t border-gray-100">
              <button onClick={()=>{setShowForm(false);setEditing(null);setSiteMsg('');}} className="btn-secondary flex-1">Close</button>
              <button onClick={saveSite} disabled={!form.name.trim()} className="btn-primary flex-1 disabled:opacity-50">
                {editing?'Save Changes':'Create Site'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Read-only map for site card preview ────────────────────────────────────────
function SiteMapReadOnly({pins,center,zoom}:{pins:SiteMapPin[];center?:[number,number];zoom?:number}){
  const ref=useRef<HTMLDivElement>(null);
  const mapRef=useRef<any>(null);
  useEffect(()=>{
    if(!ref.current)return;
    const c=center&&center[0]?center:pins.length>0?[pins[0].lat,pins[0].lng]:[-37.7826,175.2528] as any;
    const map=L.map(ref.current,{zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120, attributionControl:false,zoomControl:true,dragging:true,scrollWheelZoom:true,touchZoom:true,doubleClickZoom:true}).setView(c,zoom||14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
    mapRef.current=map;
    setTimeout(()=>{try{map.invalidateSize();}catch{}},100);
    pins.forEach(pin=>{
      const col=pin.color||'#6366f1';
      const icon=L.divIcon({className:'',
        html:`<div style="width:20px;height:20px;border-radius:50%;background:${col};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;">${pin.pinType.split(' ')[0]}</div>`,
        iconSize:[20,20],iconAnchor:[10,10]});
      const marker=L.marker([pin.lat,pin.lng],{icon}).addTo(map);
      // Tooltip: always visible label on hover
      marker.bindTooltip(pin.label||pin.pinType,{direction:'top',opacity:0.95});
      // Popup: full details on click
      const pop=document.createElement('div');
      pop.style.cssText='padding:4px 2px;min-width:160px;';
      const notesHtml=pin.notes?`<div style="font-size:10px;color:#ea580c;background:#fff7ed;border-radius:4px;padding:3px 6px;margin-top:5px;border-left:3px solid #fb923c;">💬 ${pin.notes}</div>`:'';
      pop.innerHTML=`
        <p style="font-size:12px;font-weight:700;margin:0 0 2px;color:#111;">${pin.pinType}</p>
        ${pin.label&&pin.label!==pin.pinType?`<p style="font-size:11px;margin:0 0 2px;color:#374151;">${pin.label}</p>`:''}
        <p style="font-size:10px;color:#9ca3af;margin:0;">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</p>
        ${notesHtml}
      `;
      marker.bindPopup(pop,{maxWidth:220,closeButton:true});
    });
    if(pins.length>1){
      try{map.fitBounds(L.latLngBounds(pins.map(p=>L.latLng(p.lat,p.lng))),{padding:[15,15]});}catch{}
    }
    return()=>{try{map.remove();}catch{}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  return<div ref={ref} style={{height:420}} className="w-full rounded-xl overflow-hidden"/>;
}


// ── Main export ───────────────────────────────────────────────────────────────
export default function SweepJobSites(){
  return(
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Job Sites</h1>
      <SitesTab/>
    </div>
  );
}
