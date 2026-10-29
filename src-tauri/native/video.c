// Snipcast integration of wcap. Windows system APIs only; see vendor/wcap/LICENSE.
#include "wcap.h"
// The embedded engine reports errors to Rust; never open upstream modal dialogs.
#define MessageBoxW(...) 0
#include "wcap_config.h"
#include "wcap_encoder.h"
#include <wincodec.h>
#include <propvarutil.h>

typedef struct { uint64_t duration_ms; uint32_t width, height, fps, audio; } VideoInfo;
typedef void (*RecordProgress)(void*, uint64_t, uint64_t, uint32_t);
typedef void (*ExportProgress)(void*, uint32_t);
typedef struct {
    ScreenCapture capture; Encoder encoder; AudioCapture audio;
    ID3D11Device* device; ID3D11DeviceContext* context; ID3D11Texture2D* latest;
    volatile LONG* control; uint64_t frequency, paused_ticks, pause_start, frames;
    BOOL paused, has_frame, capture_closed, hardware, f11_down, f12_down, poll_f11, poll_f12;
    volatile LONG keyboard_ticks[2];
} Recording;

// RegisterHotKey cannot claim F12 (Windows reserves it for debuggers). A tiny
// hook handles only the two unmodified recording keys. Its own lightweight
// message thread stays responsive even when the video encoder blocks.
static Recording* keyboard_recording;
static LONG control_value(volatile LONG* p);
static void recording_key(Recording* r,UINT key) {
    UINT index=key==VK_F11?0:1;DWORD now=GetTickCount();
    LONG previous=InterlockedCompareExchange(&r->keyboard_ticks[index],0,0);
    // Coalesce a hook event and the corresponding asynchronous key-state edge.
    if((DWORD)(now-(DWORD)previous)<100||InterlockedCompareExchange(&r->keyboard_ticks[index],(LONG)now,previous)!=previous)return;
    LONG current=control_value(r->control);
    if(key==VK_F12)InterlockedExchange(r->control,2);
    else if(current!=2)InterlockedCompareExchange(r->control,current==1?0:1,current);
}
static LRESULT CALLBACK record_keyboard(int code,WPARAM message,LPARAM parameter) {
    Recording* r=keyboard_recording;
    if(code==HC_ACTION&&r){
        const KBDLLHOOKSTRUCT* key=(const KBDLLHOOKSTRUCT*)parameter;
        if(key->vkCode==VK_F11||key->vkCode==VK_F12){
            BOOL* held=key->vkCode==VK_F11?&r->f11_down:&r->f12_down;
            BOOL down=message==WM_KEYDOWN||message==WM_SYSKEYDOWN;
            BOOL modified=(GetAsyncKeyState(VK_CONTROL)|GetAsyncKeyState(VK_MENU)|GetAsyncKeyState(VK_SHIFT)|GetAsyncKeyState(VK_LWIN)|GetAsyncKeyState(VK_RWIN))&0x8000;
            if(*held||!modified){
                if(down&&!*held){
                    recording_key(r,key->vkCode);
                }
                *held=down;
                // Always pass key-up through so Windows' asynchronous state is
                // released, including a key pressed before this hook existed.
                if(down)return 1;
            }
        }
    }
    return CallNextHookEx(NULL,code,message,parameter);
}
typedef struct {Recording* recording;HANDLE ready,thread;DWORD thread_id;HRESULT result;} KeyboardHook;
static DWORD WINAPI record_keyboard_thread(void* context) {
    KeyboardHook* k=context;keyboard_recording=k->recording;
    MSG msg;PeekMessageW(&msg,NULL,0,0,PM_NOREMOVE);
    HHOOK hook=SetWindowsHookExW(WH_KEYBOARD_LL,record_keyboard,NULL,0);
    k->result=hook?S_OK:HRESULT_FROM_WIN32(GetLastError());SetEvent(k->ready);
    if(hook){BOOL quit=FALSE;while(!quit){while(PeekMessageW(&msg,NULL,0,0,PM_REMOVE)){if(msg.message==WM_QUIT){quit=TRUE;break;}TranslateMessage(&msg);DispatchMessageW(&msg);}if(!quit)MsgWaitForMultipleObjectsEx(0,NULL,50,QS_ALLINPUT,MWMO_INPUTAVAILABLE);}UnhookWindowsHookEx(hook);}
    keyboard_recording=NULL;return 0;
}
static HRESULT record_keyboard_start(KeyboardHook* k,Recording* r) {
    k->recording=r;k->ready=CreateEventW(NULL,TRUE,FALSE,NULL);
    if(!k->ready)return HRESULT_FROM_WIN32(GetLastError());
    k->thread=CreateThread(NULL,128*1024,record_keyboard_thread,k,STACK_SIZE_PARAM_IS_A_RESERVATION,&k->thread_id);
    if(!k->thread)return HRESULT_FROM_WIN32(GetLastError());
    WaitForSingleObject(k->ready,INFINITE);return k->result;
}
static void record_keyboard_stop(KeyboardHook* k) {
    if(k->thread){PostThreadMessageW(k->thread_id,WM_QUIT,0,0);WaitForSingleObject(k->thread,INFINITE);CloseHandle(k->thread);}
    if(k->ready)CloseHandle(k->ready);
}
static void record_keyboard_poll(Recording* r) {
    // Windows may silently remove a low-level hook after a timeout. Keep the
    // two recording keys usable via the existing recording loop as a fallback.
    SHORT states[2]={GetAsyncKeyState(VK_F11),GetAsyncKeyState(VK_F12)};
    BOOL modified=(GetAsyncKeyState(VK_CONTROL)|GetAsyncKeyState(VK_MENU)|GetAsyncKeyState(VK_SHIFT)|GetAsyncKeyState(VK_LWIN)|GetAsyncKeyState(VK_RWIN))&0x8000;
    BOOL* held[2]={&r->poll_f11,&r->poll_f12};
    for(UINT i=0;i<2;i++){if((states[i]&0x8001)&&!*held[i]&&!modified)recording_key(r,i?VK_F12:VK_F11);*held[i]=(states[i]&0x8000)!=0;}
}

static uint64_t clock_ticks(void) { LARGE_INTEGER t; QueryPerformanceCounter(&t); return t.QuadPart; }
static LONG control_value(volatile LONG* p) { return p ? InterlockedCompareExchange(p, 0, 0) : 0; }
static HRESULT create_device(ID3D11Device** device) {
    return D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        (D3D_FEATURE_LEVEL[]){D3D_FEATURE_LEVEL_11_0}, 1, D3D11_SDK_VERSION, device, NULL, NULL);
}
static Config encoding_config(uint32_t bitrate,BOOL best) {
    return (Config){.MouseCursor=TRUE, .HardwareEncoder=TRUE, .VideoCodec=CONFIG_VIDEO_H264,
        .VideoProfile=CONFIG_VIDEO_MAIN, .VideoBitrate=bitrate, .VideoQuality=best?100:0, .AudioCodec=CONFIG_AUDIO_AAC,
        .AudioSamplerate=48000, .AudioChannels=2, .AudioBitrate=96};
}
static BOOL start_encoder(Encoder* e, ID3D11Device* d, WCHAR* path, EncoderConfig* cfg, BOOL* hardware) {
    Encoder_Init(e);
    *hardware=TRUE;
    if (Encoder_Start(e,d,path,cfg)) return TRUE;
    cfg->Config->HardwareEncoder=FALSE; *hardware=FALSE;
    if (Encoder_Start(e,d,path,cfg)) return TRUE;
    MFShutdown();
    return FALSE;
}
static bool capture_frame(ScreenCapture* capture, ScreenCaptureFrame* frame) {
    Recording* r=CONTAINING_RECORD(capture,Recording,capture);
    if (!frame) { r->capture_closed=TRUE; return true; }
    D3D11_BOX box={frame->Rect.left,frame->Rect.top,0,frame->Rect.right,frame->Rect.bottom,1};
    ID3D11DeviceContext_CopySubresourceRegion(r->context,(ID3D11Resource*)r->latest,0,0,0,0,
        (ID3D11Resource*)frame->Texture,0,&box);
    r->has_frame=TRUE;
    return true;
}
static void record_audio(Recording* r) {
    AudioCaptureData data;
    while (AudioCapture_GetData(&r->audio,&data,r->encoder.StartTime+r->paused_ticks)) {
        if (!r->paused && r->encoder.StartTime) {
            int64_t time=(int64_t)data.Time-(int64_t)r->paused_ticks;
            uint32_t count=(uint32_t)data.Count, skip=0;
            if (time<(int64_t)r->encoder.StartTime) {
                skip=(uint32_t)min((uint64_t)count,((r->encoder.StartTime-time)*r->audio.Format->nSamplesPerSec+r->frequency-1)/r->frequency);
                time+=skip*r->frequency/r->audio.Format->nSamplesPerSec; count-=skip;
            }
            if(count) Encoder_NewSamples(&r->encoder,data.Samples?(BYTE*)data.Samples+skip*r->audio.Format->nBlockAlign:NULL,
                count,(uint64_t)time,r->frequency);
        }
        AudioCapture_ReleaseData(&r->audio,&data);
    }
}

// Runs on one dedicated STA thread. Capture callbacks are dispatched on that same
// thread; no frame/sample data crosses the Rust/WebView boundary.
int32_t snipcast_video_record(WCHAR* path,int32_t x,int32_t y,uint32_t width,uint32_t height,
    uint32_t fps,uint32_t bitrate,uint32_t audio,volatile LONG* control,RecordProgress progress,void* user) {
    HRESULT hr=CoInitializeEx(NULL,COINIT_APARTMENTTHREADED);
    if(FAILED(hr)) return hr;
    Recording r={.control=control}; Config cfg=encoding_config(bitrate,TRUE);KeyboardHook keyboard={0};
    LARGE_INTEGER frequency; QueryPerformanceFrequency(&frequency); r.frequency=frequency.QuadPart;
    BOOL capture_created=FALSE, capture_started=FALSE, audio_started=FALSE, encoder_started=FALSE;
    if(!ScreenCapture_IsSupported()) {hr=HRESULT_FROM_WIN32(ERROR_OLD_WIN_VERSION);goto done;}
    RECT absolute={x,y,x+(LONG)width,y+(LONG)height}; HMONITOR monitor=MonitorFromRect(&absolute,MONITOR_DEFAULTTONULL);
    MONITORINFO mi={sizeof(mi)};
    if(!monitor||!GetMonitorInfoW(monitor,&mi)||x<mi.rcMonitor.left||y<mi.rcMonitor.top||absolute.right>mi.rcMonitor.right||absolute.bottom>mi.rcMonitor.bottom){hr=E_INVALIDARG;goto done;}
    hr=create_device(&r.device); if(FAILED(hr))goto done;
    ID3D11Device_GetImmediateContext(r.device,&r.context);
    D3D11_TEXTURE2D_DESC desc={.Width=width,.Height=height,.MipLevels=1,.ArraySize=1,.Format=DXGI_FORMAT_B8G8R8A8_UNORM,
        .SampleDesc={1,0},.Usage=D3D11_USAGE_DEFAULT,.BindFlags=D3D11_BIND_SHADER_RESOURCE};
    hr=ID3D11Device_CreateTexture2D(r.device,&desc,NULL,&r.latest); if(FAILED(hr))goto done;
    ScreenCapture_Create(&r.capture,capture_frame,false); capture_created=TRUE;
    RECT region={x-mi.rcMonitor.left,y-mi.rcMonitor.top,x-mi.rcMonitor.left+(LONG)width,y-mi.rcMonitor.top+(LONG)height};
    if(!ScreenCapture_CreateForMonitor(&r.capture,r.device,monitor,&region)){hr=E_FAIL;goto done;}
    // Stop also releases the created frame pool when startup fails.
    capture_started=TRUE;
    if(audio) {if(!AudioCapture_Start(&r.audio,NULL)){hr=HRESULT_FROM_WIN32(ERROR_NOT_READY);goto done;}audio_started=TRUE;}
    EncoderConfig ec={width,height,fps,1,audio_started?r.audio.Format:NULL,&cfg};
    if(!start_encoder(&r.encoder,r.device,path,&ec,&r.hardware)){hr=MF_E_TOPO_CODEC_NOT_FOUND;goto done;}encoder_started=TRUE;
    ScreenCapture_Start(&r.capture,TRUE,FALSE,FALSE);
    // Discard key-state history from the preceding session (especially Stop).
    // A held key must be released before it can control a new recording.
    r.poll_f11=r.f11_down=(GetAsyncKeyState(VK_F11)&0x8000)!=0;
    r.poll_f12=r.f12_down=(GetAsyncKeyState(VK_F12)&0x8000)!=0;
    hr=record_keyboard_start(&keyboard,&r);if(FAILED(hr))goto done;
    progress(user,0,0,r.hardware);
    uint64_t next=clock_ticks(), reported=0, started=next;
    while(control_value(control)!=2&&!r.capture_closed) {
        MSG msg; while(PeekMessageW(&msg,NULL,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
        record_keyboard_poll(&r);
        uint64_t now=clock_ticks(); BOOL pause=control_value(control)==1;
        if(pause&&!r.paused){r.pause_start=now;r.paused=TRUE;}
        if(!pause&&r.paused){r.paused_ticks+=now-r.pause_start;r.paused=FALSE;next=now;}
        if(!r.paused&&r.has_frame&&now>=next){
            RECT rect={0,0,(LONG)width,(LONG)height};
            if(Encoder_NewFrame(&r.encoder,r.latest,rect,now-r.paused_ticks,r.frequency))r.frames++;
            next=now+r.frequency/fps;
        }
        if(audio_started)record_audio(&r);
        if(now-reported>=r.frequency/4){
            uint64_t active=now-r.paused_ticks-(r.paused?now-r.pause_start:0);
            progress(user,r.encoder.StartTime?(active-r.encoder.StartTime)*1000/r.frequency:0,r.frames,r.hardware);reported=now;
        }
        if(!r.has_frame&&now-started>r.frequency*8){hr=HRESULT_FROM_WIN32(ERROR_TIMEOUT);break;}
        Sleep(5);
    }
    if(!r.frames)hr=E_FAIL;
done:
    record_keyboard_stop(&keyboard);
    if(capture_started)ScreenCapture_Stop(&r.capture);
    if(audio_started){AudioCapture_Flush(&r.audio);if(encoder_started)record_audio(&r);AudioCapture_Stop(&r.audio);}
    if(encoder_started){HRESULT final=Encoder_Stop(&r.encoder);if(SUCCEEDED(hr)&&FAILED(final))hr=final;MFShutdown();}
    if(capture_created)ScreenCapture_Release(&r.capture);
    if(r.latest)ID3D11Texture2D_Release(r.latest);
    if(r.context)ID3D11DeviceContext_Release(r.context);
    if(r.device)ID3D11Device_Release(r.device);
    CoUninitialize(); return hr;
}

static HRESULT reader_open(const WCHAR* path,IMFSourceReader** reader,DWORD* video,DWORD* audio) {
    IMFAttributes* attributes=NULL;HRESULT hr=MFCreateAttributes(&attributes,2);
    if(FAILED(hr))return hr;
    // The legacy RGB converter exposes padded H.264 macroblock storage as a
    // flat buffer while reporting the visible width's stride (386 != 400).
    // The system video processor preserves the actual 2D surface layout.
    IMFAttributes_SetUINT32(attributes,&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,TRUE);
    hr=MFCreateSourceReaderFromURL(path,attributes,reader);IMFAttributes_Release(attributes);
    if(FAILED(hr))return hr;
    *video=*audio=UINT32_MAX;
    for(DWORD i=0;i<32;i++){
        IMFMediaType* type=NULL;GUID major;
        if(FAILED(IMFSourceReader_GetNativeMediaType(*reader,i,0,&type)))break;
        if(SUCCEEDED(IMFMediaType_GetGUID(type,&MF_MT_MAJOR_TYPE,&major))){
            if(IsEqualGUID(&major,&MFMediaType_Video)&&*video==UINT32_MAX)*video=i;
            if(IsEqualGUID(&major,&MFMediaType_Audio)&&*audio==UINT32_MAX)*audio=i;
        }
        IMFMediaType_Release(type);
    }
    return *video==UINT32_MAX?MF_E_INVALIDMEDIATYPE:S_OK;
}
static HRESULT reader_info(IMFSourceReader* reader,DWORD video,DWORD audio,VideoInfo* info) {
    IMFMediaType* type=NULL; HRESULT hr=IMFSourceReader_GetNativeMediaType(reader,video,0,&type);if(FAILED(hr))return hr;
    UINT64 size=0,rate=0;IMFMediaType_GetUINT64(type,&MF_MT_FRAME_SIZE,&size);IMFMediaType_GetUINT64(type,&MF_MT_FRAME_RATE,&rate);
    info->width=(uint32_t)(size>>32);info->height=(uint32_t)size;
    info->fps=(uint32_t)rate?(uint32_t)((rate>>32)/(uint32_t)rate):30;info->audio=audio!=UINT32_MAX;
    IMFMediaType_Release(type);
    PROPVARIANT duration;PropVariantInit(&duration);
    hr=IMFSourceReader_GetPresentationAttribute(reader,MF_SOURCE_READER_MEDIASOURCE,&MF_PD_DURATION,&duration);
    if(SUCCEEDED(hr)&&duration.vt==VT_UI8)info->duration_ms=duration.uhVal.QuadPart/10000;
    PropVariantClear(&duration);return hr;
}
int32_t snipcast_video_probe(const WCHAR* path,VideoInfo* info) {
    HRESULT hr=CoInitializeEx(NULL,COINIT_MULTITHREADED);if(FAILED(hr))return hr;
    IMFSourceReader* reader=NULL;DWORD video,audio;hr=MFStartup(MF_VERSION,MFSTARTUP_LITE);
    if(SUCCEEDED(hr))hr=reader_open(path,&reader,&video,&audio);
    if(SUCCEEDED(hr))hr=reader_info(reader,video,audio,info);
    if(reader)IMFSourceReader_Release(reader);MFShutdown();CoUninitialize();return hr;
}

typedef struct { IWICImagingFactory* factory; IWICBitmapEncoder* encoder; IWICBitmap* pending;
    BYTE* previous; DWORD length,delay; uint64_t count; UINT width,height,fps; } GifWriter;
#define TRY(expr) do {hr=(expr);if(FAILED(hr))goto done;}while(0)
static HRESULT gif_open(GifWriter* g,const WCHAR* path,UINT width,UINT height,UINT fps) {
    HRESULT hr;IWICStream* stream=NULL;g->width=width;g->height=height;g->fps=fps;
    TRY(CoCreateInstance(&CLSID_WICImagingFactory,NULL,CLSCTX_INPROC_SERVER,&IID_IWICImagingFactory,(void**)&g->factory));
    TRY(IWICImagingFactory_CreateStream(g->factory,&stream));TRY(IWICStream_InitializeFromFilename(stream,path,GENERIC_WRITE));
    TRY(IWICImagingFactory_CreateEncoder(g->factory,&GUID_ContainerFormatGif,NULL,&g->encoder));
    TRY(IWICBitmapEncoder_Initialize(g->encoder,(IStream*)stream,WICBitmapEncoderNoCache));
    IWICMetadataQueryWriter* meta=NULL;
    if(SUCCEEDED(IWICBitmapEncoder_GetMetadataQueryWriter(g->encoder,&meta))){
        BYTE application[]="NETSCAPE2.0",loop[]={3,1,0,0,0};
        PROPVARIANT v={.vt=VT_UI1|VT_VECTOR,.caub={11,application}};
        IWICMetadataQueryWriter_SetMetadataByName(meta,L"/appext/application",&v);
        v.caub.cElems=5;v.caub.pElems=loop;IWICMetadataQueryWriter_SetMetadataByName(meta,L"/appext/data",&v);
        IWICMetadataQueryWriter_Release(meta);
    }
    g->length=width*height*4;g->previous=HeapAlloc(GetProcessHeap(),0,g->length);if(!g->previous)hr=E_OUTOFMEMORY;
done: if(stream)IWICStream_Release(stream);return hr;
}
static HRESULT gif_flush(GifWriter* g) {
    if(!g->pending)return S_OK;
    HRESULT hr;IWICBitmapFrameEncode* frame=NULL;IPropertyBag2* options=NULL;IWICPalette* palette=NULL;
    IWICFormatConverter* converter=NULL;IWICMetadataQueryWriter* meta=NULL;
    TRY(IWICBitmapEncoder_CreateNewFrame(g->encoder,&frame,&options));TRY(IWICBitmapFrameEncode_Initialize(frame,options));
    TRY(IWICBitmapFrameEncode_SetSize(frame,g->width,g->height));
    WICPixelFormatGUID format=GUID_WICPixelFormat8bppIndexed;TRY(IWICBitmapFrameEncode_SetPixelFormat(frame,&format));
    TRY(IWICImagingFactory_CreatePalette(g->factory,&palette));
    TRY(IWICPalette_InitializeFromBitmap(palette,(IWICBitmapSource*)g->pending,256,FALSE));
    TRY(IWICBitmapFrameEncode_SetPalette(frame,palette));
    TRY(IWICImagingFactory_CreateFormatConverter(g->factory,&converter));
    TRY(IWICFormatConverter_Initialize(converter,(IWICBitmapSource*)g->pending,&GUID_WICPixelFormat8bppIndexed,
        WICBitmapDitherTypeNone,palette,0,WICBitmapPaletteTypeCustom));
    TRY(IWICBitmapFrameEncode_GetMetadataQueryWriter(frame,&meta));
    PROPVARIANT v={.vt=VT_UI2,.uiVal=(USHORT)min(g->delay,65535)};
    TRY(IWICMetadataQueryWriter_SetMetadataByName(meta,L"/grctlext/Delay",&v));
    v.vt=VT_UI1;v.bVal=1;TRY(IWICMetadataQueryWriter_SetMetadataByName(meta,L"/grctlext/Disposal",&v));
    TRY(IWICBitmapFrameEncode_WriteSource(frame,(IWICBitmapSource*)converter,NULL));TRY(IWICBitmapFrameEncode_Commit(frame));
done:
    if(meta)IWICMetadataQueryWriter_Release(meta);if(converter)IWICFormatConverter_Release(converter);
    if(palette)IWICPalette_Release(palette);if(options)IPropertyBag2_Release(options);if(frame)IWICBitmapFrameEncode_Release(frame);
    return hr;
}
static HRESULT gif_frame(GifWriter* g,BYTE* pixels,UINT width,UINT height,WICRect* crop) {
    HRESULT hr;IWICBitmap* input=NULL;IWICBitmapClipper* clipper=NULL;IWICBitmapScaler* scaler=NULL;IWICBitmap* bitmap=NULL;
    BYTE* current=NULL;
    TRY(IWICImagingFactory_CreateBitmapFromMemory(g->factory,width,height,&GUID_WICPixelFormat32bppBGR,width*4,width*height*4,pixels,&input));
    TRY(IWICImagingFactory_CreateBitmapClipper(g->factory,&clipper));TRY(IWICBitmapClipper_Initialize(clipper,(IWICBitmapSource*)input,crop));
    TRY(IWICImagingFactory_CreateBitmapScaler(g->factory,&scaler));TRY(IWICBitmapScaler_Initialize(scaler,(IWICBitmapSource*)clipper,g->width,g->height,WICBitmapInterpolationModeFant));
    TRY(IWICImagingFactory_CreateBitmapFromSource(g->factory,(IWICBitmapSource*)scaler,WICBitmapCacheOnLoad,&bitmap));
    current=HeapAlloc(GetProcessHeap(),0,g->length);if(!current){hr=E_OUTOFMEMORY;goto done;}
    TRY(IWICBitmap_CopyPixels(bitmap,NULL,g->width*4,g->length,current));
    // Coalesce identical frames. A static screen is one GIF frame with a longer
    // delay instead of hundreds of duplicate images; memory stays bounded.
    if(g->pending&&(g->delay>65000||memcmp(current,g->previous,g->length))){
        TRY(gif_flush(g));IWICBitmap_Release(g->pending);g->pending=NULL;g->delay=0;
    }
    if(!g->pending){g->pending=bitmap;bitmap=NULL;memcpy(g->previous,current,g->length);}
    g->delay+=(DWORD)(((g->count+1)*100+g->fps/2)/g->fps-(g->count*100+g->fps/2)/g->fps);g->count++;
done:
    if(current)HeapFree(GetProcessHeap(),0,current);if(bitmap)IWICBitmap_Release(bitmap);
    if(scaler)IWICBitmapScaler_Release(scaler);if(clipper)IWICBitmapClipper_Release(clipper);if(input)IWICBitmap_Release(input);
    return hr;
}
static void gif_release(GifWriter* g) {
    if(g->pending)IWICBitmap_Release(g->pending);if(g->encoder)IWICBitmapEncoder_Release(g->encoder);
    if(g->factory)IWICImagingFactory_Release(g->factory);if(g->previous)HeapFree(GetProcessHeap(),0,g->previous);
}
static HRESULT copy_video_pixels(IMFSample* sample,BYTE* pixels,UINT width,UINT height,LONG fallback_stride) {
    // Preserve the video processor's 2D buffer and its actual signed row pitch.
    // Flattening first can lose surface padding for non-aligned frame widths.
    IMFMediaBuffer* buffer=NULL;IMF2DBuffer* two=NULL;DWORD buffers=0;
    HRESULT hr=IMFSample_GetBufferCount(sample,&buffers);if(FAILED(hr))return hr;
    hr=buffers==1?IMFSample_GetBufferByIndex(sample,0,&buffer):IMFSample_ConvertToContiguousBuffer(sample,&buffer);
    if(FAILED(hr))return hr;
    BYTE* scan=NULL;LONG pitch=fallback_stride;
    if(SUCCEEDED(IMFMediaBuffer_QueryInterface(buffer,&IID_IMF2DBuffer,(void**)&two))){
        hr=IMF2DBuffer_Lock2D(two,&scan,&pitch);
        if(SUCCEEDED(hr)){
            uint64_t row_pitch=pitch<0?-(int64_t)pitch:pitch;
            if(row_pitch<(uint64_t)width*4)hr=E_INVALIDARG;
            else for(UINT y=0;y<height;y++)memcpy(pixels+y*width*4,scan+(int64_t)y*pitch,width*4);
            IMF2DBuffer_Unlock2D(two);
        }
        IMF2DBuffer_Release(two);
    }else{
        DWORD length=0;hr=IMFMediaBuffer_Lock(buffer,&scan,NULL,&length);
        if(SUCCEEDED(hr)){
            uint64_t row_pitch=pitch<0?-(int64_t)pitch:pitch;
            // A flat RGB32 buffer must agree with the negotiated stride. Do not
            // silently interpret unknown macroblock padding as visible pixels.
            if(row_pitch<(uint64_t)width*4||length!=row_pitch*height)hr=E_INVALIDARG;
            else {if(pitch<0)scan+=(height-1)*row_pitch;for(UINT y=0;y<height;y++)memcpy(pixels+y*width*4,scan+(int64_t)y*pitch,width*4);}
            IMFMediaBuffer_Unlock(buffer);
        }
    }
    IMFMediaBuffer_Release(buffer);return hr;
}

int32_t snipcast_video_export(const WCHAR* source,WCHAR* target,uint64_t start_ms,uint64_t end_ms,
    uint32_t cx,uint32_t cy,uint32_t cw,uint32_t ch,uint32_t bitrate,uint32_t best,uint32_t gif_width,uint32_t gif_fps,
    volatile LONG* cancel,ExportProgress progress,void* user) {
    HRESULT hr=CoInitializeEx(NULL,COINIT_MULTITHREADED);if(FAILED(hr))return hr;
    IMFSourceReader* reader=NULL;IMFMediaType* type=NULL;IMFSample* sample=NULL;
    ID3D11Device* device=NULL;ID3D11DeviceContext* context=NULL;ID3D11Texture2D* texture=NULL;
    Encoder encoder={0};BOOL encoded=FALSE,hardware=FALSE, mf=FALSE;GifWriter gif={0};BYTE* pixels=NULL;
    DWORD video=UINT32_MAX,audio=UINT32_MAX;VideoInfo info={0};LONG stride=0;
    TRY(MFStartup(MF_VERSION,MFSTARTUP_LITE));mf=TRUE;TRY(reader_open(source,&reader,&video,&audio));TRY(reader_info(reader,video,audio,&info));
    if(!cw||!ch||cx+cw>info.width||cy+ch>info.height||end_ms<=start_ms||gif_width>960||gif_fps>15){hr=E_INVALIDARG;goto done;}
    TRY(IMFSourceReader_SetStreamSelection(reader,MF_SOURCE_READER_ALL_STREAMS,FALSE));TRY(IMFSourceReader_SetStreamSelection(reader,video,TRUE));
    TRY(MFCreateMediaType(&type));TRY(IMFMediaType_SetGUID(type,&MF_MT_MAJOR_TYPE,&MFMediaType_Video));TRY(IMFMediaType_SetGUID(type,&MF_MT_SUBTYPE,&MFVideoFormat_RGB32));
    TRY(IMFSourceReader_SetCurrentMediaType(reader,video,NULL,type));IMFMediaType_Release(type);type=NULL;
    TRY(IMFSourceReader_GetCurrentMediaType(reader,video,&type));UINT32 stride_value=info.width*4;
    IMFMediaType_GetUINT32(type,&MF_MT_DEFAULT_STRIDE,&stride_value);
    stride=(LONG)stride_value;IMFMediaType_Release(type);type=NULL;
    WAVEFORMATEX wave={WAVE_FORMAT_PCM,2,48000,192000,4,16,0};
    if(!gif_width&&audio!=UINT32_MAX){
        TRY(MFCreateMediaType(&type));TRY(IMFMediaType_SetGUID(type,&MF_MT_MAJOR_TYPE,&MFMediaType_Audio));TRY(IMFMediaType_SetGUID(type,&MF_MT_SUBTYPE,&MFAudioFormat_PCM));
        TRY(IMFMediaType_SetUINT32(type,&MF_MT_AUDIO_NUM_CHANNELS,2));TRY(IMFMediaType_SetUINT32(type,&MF_MT_AUDIO_SAMPLES_PER_SECOND,48000));
        TRY(IMFMediaType_SetUINT32(type,&MF_MT_AUDIO_BITS_PER_SAMPLE,16));TRY(IMFMediaType_SetUINT32(type,&MF_MT_AUDIO_BLOCK_ALIGNMENT,4));TRY(IMFMediaType_SetUINT32(type,&MF_MT_AUDIO_AVG_BYTES_PER_SECOND,192000));
        TRY(IMFSourceReader_SetCurrentMediaType(reader,audio,NULL,type));IMFMediaType_Release(type);type=NULL;TRY(IMFSourceReader_SetStreamSelection(reader,audio,TRUE));
    }else audio=UINT32_MAX;
    pixels=HeapAlloc(GetProcessHeap(),0,(SIZE_T)info.width*info.height*4);if(!pixels){hr=E_OUTOFMEMORY;goto done;}
    if(gif_width){UINT ow=min(gif_width,cw),oh=max(1,ch*ow/cw);TRY(gif_open(&gif,target,ow,oh,gif_fps));}
    else{
        TRY(create_device(&device));ID3D11Device_GetImmediateContext(device,&context);
        D3D11_TEXTURE2D_DESC desc={.Width=info.width,.Height=info.height,.MipLevels=1,.ArraySize=1,.Format=DXGI_FORMAT_B8G8R8A8_UNORM,
            .SampleDesc={1,0},.Usage=D3D11_USAGE_DEFAULT,.BindFlags=D3D11_BIND_SHADER_RESOURCE};
        TRY(ID3D11Device_CreateTexture2D(device,&desc,NULL,&texture));Config cfg=encoding_config(bitrate,best!=0);
        EncoderConfig ec={cw,ch,max(1,info.fps),1,audio!=UINT32_MAX?&wave:NULL,&cfg};
        if(!start_encoder(&encoder,device,target,&ec,&hardware)){hr=MF_E_TOPO_CODEC_NOT_FOUND;goto done;}encoded=TRUE;
    }
    PROPVARIANT seek={.vt=VT_I8};seek.hVal.QuadPart=(int64_t)start_ms*10000;
    TRY(IMFSourceReader_SetCurrentPosition(reader,&GUID_NULL,&seek));
    BOOL veof=FALSE,aeof=audio==UINT32_MAX;uint64_t next_gif=start_ms*10000, count=0;UINT last_percent=UINT32_MAX;
    while(!veof||!aeof){
        if(control_value(cancel)==2){hr=E_ABORT;goto done;}
        DWORD index=0,flags=0;LONGLONG timestamp=0;
        TRY(IMFSourceReader_ReadSample(reader,MF_SOURCE_READER_ANY_STREAM,0,&index,&flags,&timestamp,&sample));
        if(flags&MF_SOURCE_READERF_ERROR){hr=E_FAIL;goto done;}
        if(flags&MF_SOURCE_READERF_ENDOFSTREAM){if(index==video)veof=TRUE;if(index==audio)aeof=TRUE;}
        if(timestamp>=(LONGLONG)end_ms*10000){
            if(index==video)veof=TRUE;if(index==audio)aeof=TRUE;
            IMFSourceReader_SetStreamSelection(reader,index,FALSE);
        }else if(sample&&index==video&&timestamp>=(LONGLONG)start_ms*10000){
            if(!gif_width||(uint64_t)timestamp>=next_gif){
                TRY(copy_video_pixels(sample,pixels,info.width,info.height,stride));
                if(gif_width){WICRect crop={(INT)cx,(INT)cy,(INT)cw,(INT)ch};TRY(gif_frame(&gif,pixels,info.width,info.height,&crop));next_gif=start_ms*10000+gif.count*MF_UNITS_PER_SECOND/gif_fps;}
                else{
                    ID3D11DeviceContext_UpdateSubresource(context,(ID3D11Resource*)texture,0,NULL,pixels,info.width*4,0);
                    RECT rect={cx,cy,cx+cw,cy+ch};uint64_t t=(uint64_t)timestamp-start_ms*10000+1;
                    while(!Encoder_NewFrame(&encoder,texture,rect,t,MF_UNITS_PER_SECOND)){if(control_value(cancel)==2){hr=E_ABORT;goto done;}Sleep(1);}
                }
                count++;
            }
            UINT percent=(UINT)min(99,((uint64_t)timestamp/10000-start_ms)*100/(end_ms-start_ms));
            if(percent!=last_percent){progress(user,percent);last_percent=percent;}
        }else if(sample&&index==audio){
            IMFMediaBuffer* buffer=NULL;BYTE* data=NULL;DWORD length=0;
            TRY(IMFSample_ConvertToContiguousBuffer(sample,&buffer));hr=IMFMediaBuffer_Lock(buffer,&data,NULL,&length);
            if(SUCCEEDED(hr)&&encoder.StartTime){
                UINT frames=length/4,skip=0;LONGLONG from=(LONGLONG)start_ms*10000,until=(LONGLONG)end_ms*10000;
                if(timestamp<from)skip=(UINT)min((uint64_t)frames,((from-timestamp)*48000+MF_UNITS_PER_SECOND-1)/MF_UNITS_PER_SECOND);
                timestamp+=skip*MF_UNITS_PER_SECOND/48000;frames-=skip;
                if(timestamp<until&&timestamp>=from){frames=(UINT)min((uint64_t)frames,(until-timestamp)*48000/MF_UNITS_PER_SECOND);
                    if(frames)Encoder_NewSamples(&encoder,data+skip*4,frames,timestamp-from+1,MF_UNITS_PER_SECOND);}
            }
            if(data)IMFMediaBuffer_Unlock(buffer);IMFMediaBuffer_Release(buffer);if(FAILED(hr))goto done;
        }
        if(sample){IMFSample_Release(sample);sample=NULL;}
    }
    if(!count){hr=MF_E_END_OF_STREAM;goto done;}
    if(gif_width){TRY(gif_flush(&gif));TRY(IWICBitmapEncoder_Commit(gif.encoder));}
    hr=S_OK;
done:
    if(sample)IMFSample_Release(sample);if(type)IMFMediaType_Release(type);if(reader)IMFSourceReader_Release(reader);
    if(encoded){HRESULT final=Encoder_Stop(&encoder);if(SUCCEEDED(hr)&&FAILED(final))hr=final;MFShutdown();}gif_release(&gif);
    if(texture)ID3D11Texture2D_Release(texture);if(context)ID3D11DeviceContext_Release(context);if(device)ID3D11Device_Release(device);
    if(pixels)HeapFree(GetProcessHeap(),0,pixels);if(mf)MFShutdown();CoUninitialize();
    if(FAILED(hr))DeleteFileW(target);else progress(user,100);return hr;
}
