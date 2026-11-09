import numpy as np, wave
SR=48000; DUR=20.0; N=int(SR*DUR); BEAT=0.5
rng=np.random.default_rng(7)
f=lambda m:440*2**((m-69)/12)
def buf(): return np.zeros(N)
def add(dst,sig,t,g=1.0):
    i=int(t*SR); j=min(N,i+len(sig))
    if i<N: dst[i:j]+=sig[:j-i]*g
def env(n,a,d):  # attack seconds, exp decay seconds
    x=np.arange(n)/SR; return np.minimum(1,x/max(a,1e-4))*np.exp(-x/d)
def lp(x,c):  # one-pole lowpass, c in Hz
    a=np.exp(-2*np.pi*c/SR); y=np.empty_like(x); s=0.0
    for i in range(len(x)): s=(1-a)*x[i]+a*s; y[i]=s
    return y
def lpf(x,c):  # faster vectorised-ish via FFT brickwall-ish smooth
    X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(fr/c)**4); return np.fft.irfft(X,len(x))
def saw(fr,n,det=0):
    x=np.arange(n)/SR; out=0
    for d in (-det,0,det): out=out+2*((x*fr*2**(d/1200))%1)-1
    return out/3
chords=[[62,66,69],[61,64,69],[59,62,66],[59,62,67]]  # D, A/C#, Bm, G (voiced)
roots=[38,33,35,31]
drums,bass,pad,pluck,sfx=buf(),buf(),buf(),buf(),buf()
nb=int(DUR/BEAT)
for b in range(nb):
    t=b*BEAT; bar=b//4
    if t<18 and b%2==0:  # kick on 1 and 3
        n=int(.35*SR); x=np.arange(n)/SR; ph=2*np.pi*np.cumsum(45+90*np.exp(-x*28))/SR
        add(drums,np.sin(ph)*env(n,.002,.12),t,.9 if t>=0.0 else 0)
    if 2<=t<18:  # hats on offbeat 8ths, and soft clap on 2/4 from bar 2
        n=int(.05*SR); h=np.diff(rng.standard_normal(n+1))*env(n,.001,.012)
        add(drums,h,t+.25,.10)
        if b%2==1 and t>=4:
            n=int(.2*SR); c=lpf(rng.standard_normal(n),2500)*env(n,.002,.05); add(drums,c,t,.22)
# bass: eighths of root
for k in range(int(18/0.25)):
    t=k*.25; r=roots[int(t//2)%4]; n=int(.24*SR)
    s=lpf(saw(f(r),n),420)*env(n,.005,.18); add(bass,s,t,.55 if t>=2 else .0)
add(bass,lpf(saw(f(38),int(3*SR)),300)*env(int(3*SR),.01,1.2),16,.5)
# pad
for bar in range(10):
    ch=chords[bar%4] if bar<8 else [62,66,69,74]
    n=int(2.1*SR); x=np.arange(n)/SR
    s=sum(saw(f(m),n,8) for m in ch)/len(ch)
    e=np.minimum(1,x/.35)*np.minimum(1,(2.1-x)/.3)
    if bar>=8: n=int(4*SR); x=np.arange(n)/SR; s=sum(saw(f(m),n,8) for m in ch)/len(ch); e=np.minimum(1,x/.3)*np.exp(-x/1.4)
    add(pad,lpf(s,1400 if bar<8 else 2000)*e,bar*2,.16 if bar else .10)
# pluck arpeggio from 4s
def pl(m,n=int(.5*SR),d=.16):
    x=np.arange(n)/SR; return (np.sin(2*np.pi*f(m)*x)+.3*np.sin(4*np.pi*f(m)*x)+.1*np.sin(6*np.pi*f(m)*x))*env(n,.002,d)
pat=[0,1,2,1,2,0,1,2]
for k in range(int(4/0.25),int(16/0.25)):
    t=k*.25; ch=chords[int(t//2)%4]; m=ch[pat[k%8]]+12
    add(pluck,pl(m),t,.10 if k%2==0 else .06)
# SFX in key, on the grid
def whoosh(t_end,len_s=.5,g=.07):
    n=int(len_s*SR); x=np.arange(n)/SR; s=lpf(rng.standard_normal(n),1800)*(x/len_s)**2; add(sfx,s,t_end-len_s,g)
for t in (4,8,12,16): whoosh(t)
add(sfx,pl(81,d=.25),1.5,.14); add(sfx,pl(78,d=.25),1.5,.12)          # two drags
n=int(.6*SR); x=np.arange(n)/SR                                          # refusal thud D2 + muted A2
th=np.sin(2*np.pi*np.cumsum(f(38)*(1+.6*np.exp(-x*20)))/SR)*env(n,.002,.16)+.4*lpf(saw(f(45),n),500)*env(n,.002,.12)
add(sfx,th,4.0,.55)
add(sfx,pl(86,d=.3),9.5,.13)                                             # B hold pluck
for i,m in enumerate((74,78,81,86)):                                     # booked chime
    n=int(1.6*SR); x=np.arange(n)/SR; s=(np.sin(2*np.pi*f(m)*x)+.25*np.sin(2*np.pi*f(m)*2.01*x))*env(n,.003,.6); add(sfx,s,10.5+i*.03,.09)
for i,m in enumerate((62,66,69,74,78)):                                  # outro bell
    n=int(3.5*SR); x=np.arange(n)/SR; s=(np.sin(2*np.pi*f(m)*x)+.2*np.sin(2*np.pi*f(m)*3.0*x))*env(n,.004,1.2); add(sfx,s,16+i*.04,.07)
# reverb
ir_n=int(1.4*SR); ir=rng.standard_normal(ir_n)*np.exp(-np.arange(ir_n)/SR/0.35); ir=lpf(ir,4000); ir/=np.sqrt((ir**2).sum())
def verb(x): L=len(x)+ir_n; return np.fft.irfft(np.fft.rfft(x,L)*np.fft.rfft(ir,L),L)[:len(x)]
wet=pad*1.0+pluck+sfx
mix=drums+bass+pad+pluck+sfx+0.22*verb(wet)
fade=np.ones(N); x=np.arange(N)/SR; fade[x>18.6]=np.cos((x[x>18.6]-18.6)/1.4*np.pi/2)**2
mix*=fade; mix=np.tanh(mix*1.3)/1.3; mix*=0.89/np.max(np.abs(mix))
# light stereo: pluck/sfx slightly wide via delay
d=int(.012*SR); R=mix.copy(); R[d:]=mix[:-d]*.15+mix[d:]*.85
st=np.stack([mix,R],1); pcm=(st*32767).astype(np.int16)
with wave.open('music.wav','wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('ok', np.sqrt((mix**2).mean()))
