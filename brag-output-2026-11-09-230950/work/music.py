import numpy as np, wave
SR=48000; DUR=21.6; N=int(SR*DUR); BEAT=0.6; BAR=2.4
rng=np.random.default_rng(11)
f=lambda m:440*2**((m-69)/12)
buf=lambda:np.zeros(N)
def add(dst,sig,t,g=1.0):
    i=int(round(t*SR)); j=min(N,i+len(sig))
    if i<N: dst[i:j]+=sig[:j-i]*g
def env(n,a,d): x=np.arange(n)/SR; return np.minimum(1,x/max(a,1e-4))*np.exp(-x/d)
def lpf(x,c): X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(fr/c)**4); return np.fft.irfft(X,len(x))
def hpf(x,c): X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(c/np.maximum(fr,1))**4); return np.fft.irfft(X,len(x))
def ep(m,n,d=1.0):  # electric-piano-ish: sine + bell partial, light tremolo
    x=np.arange(n)/SR; fr=f(m)
    s=np.sin(2*np.pi*fr*x+.6*np.sin(2*np.pi*fr*x)*np.exp(-x*6))+.15*np.sin(2*np.pi*fr*4*x)*np.exp(-x*8)
    return s*env(n,.004,d)*(1+.08*np.sin(2*np.pi*4.5*x))
def tick(g,hi=True):
    n=int(.03*SR); s=hpf(rng.standard_normal(n),5000 if hi else 2500)*env(n,.0005,.006); return s*g
chords=[[65,69,72,76],[62,65,69,72],[58,62,65,69],[60,64,67,70]]  # Fmaj7, Dm7, Bbmaj7, C7
roots=[41,38,34,36]
drums,bass,keys,sfx=buf(),buf(),buf(),buf()
nb=int(DUR/BEAT)
for b in range(nb):
    t=b*BEAT
    if t<16.8:
        if b%4==0: n=int(.4*SR); x=np.arange(n)/SR; add(drums,np.sin(2*np.pi*np.cumsum(42+70*np.exp(-x*30))/SR)*env(n,.002,.14),t,.85)
        if b%4==2 and t>=3.6: n=int(.4*SR); x=np.arange(n)/SR; add(drums,np.sin(2*np.pi*np.cumsum(42+70*np.exp(-x*30))/SR)*env(n,.002,.12),t,.5)
        if not(10.8<=t<13.2): add(drums,tick(1),t,.10)
# countdown: 8th-note clock ticks, alternating tock
for k in range(int(10.8/0.3),int(13.2/0.3)):
    t=k*.3; add(drums,tick(1,k%2==0),t,.16 if k%2==0 else .10)
# bass: half notes from 3.6
for k in range(int(3.6/1.2),int(16.8/1.2)):
    t=k*1.2; r=roots[int(t//BAR)%4]; n=int(1.15*SR); x=np.arange(n)/SR
    s=lpf(np.sin(2*np.pi*f(r)*x)+.3*np.sin(4*np.pi*f(r)*x),300)*env(n,.01,.5); add(bass,s,t,.5)
# keys: chord on 1, and a softer comp on beat 3 (from bar 2)
for bar in range(7):
    ch=chords[bar%4]; t=bar*BAR
    for i,m in enumerate(ch): add(keys,ep(m,int(2.4*SR),1.1),t+i*.012,.07)
    if bar>=1:
        for m in ch[1:]: add(keys,ep(m+12,int(1.2*SR),.35),t+1.2+.3,.03)
# SFX in key (F major)
def wood(m,g): n=int(.25*SR); x=np.arange(n)/SR; add(sfx,(np.sin(2*np.pi*f(m)*x)+.4*np.sin(2*np.pi*f(m)*2.7*x))*env(n,.001,.05),0,0); return (np.sin(2*np.pi*f(m)*x)+.4*np.sin(2*np.pi*f(m)*2.7*x))*env(n,.001,.05)*g
add(sfx,wood(72,1),.6,.35); add(sfx,wood(77,1),1.2,.35)               # cards land
for t,m in ((3.6,60),(3.9,53)):                                         # "nope": C4 → F3, muted
    n=int(.45*SR); x=np.arange(n)/SR; add(sfx,lpf(np.sign(np.sin(2*np.pi*f(m)*x))*.5+np.sin(2*np.pi*f(m)*x),900)*env(n,.004,.12),t,.32)
for t in (6.0,10.8,14.4):                                               # hard-cut thump
    n=int(.3*SR); x=np.arange(n)/SR; add(sfx,np.sin(2*np.pi*f(29)*x)*env(n,.003,.09),t,.4)
for t in (7.8,9.0): add(sfx,wood(84,1),t,.22); add(sfx,tick(1),t,.3)   # taps
for i,m in enumerate((77,81,84)): add(sfx,ep(m,int(1.6*SR),.6),9.6+i*.04,.08)   # Sent
for i,m in enumerate((84,89,93)): add(sfx,ep(m,int(2.4*SR),1.0),13.2+i*.06,.05) # freed, airy
n=int(.5*SR); x=np.arange(n)/SR; add(sfx,np.sin(2*np.pi*np.cumsum(f(41)*(1+.5*np.exp(-x*25)))/SR)*env(n,.002,.15),15.6,.5)  # refused
for i,m in enumerate((53,65,69,72,79)): add(sfx,ep(m,int(4.8*SR),1.8),16.8+i*.05,.09)     # outro F add9
ir_n=int(1.8*SR); ir=lpf(rng.standard_normal(ir_n)*np.exp(-np.arange(ir_n)/SR/.5),3500); ir/=np.sqrt((ir**2).sum())
def verb(x): L=len(x)+ir_n; return np.fft.irfft(np.fft.rfft(x,L)*np.fft.rfft(ir,L),L)[:len(x)]
mix=drums+bass+keys+sfx+.25*verb(keys+sfx)
x=np.arange(N)/SR; m=x>19.8; fade=np.ones(N); fade[m]=np.cos((x[m]-19.8)/1.8*np.pi/2)**2
mix*=fade; mix=np.tanh(mix*1.4)/1.4; mix*=.89/np.abs(mix).max()
d=int(.011*SR); R=mix.copy(); R[d:]=mix[:-d]*.15+mix[d:]*.85
pcm=(np.stack([mix,R],1)*32767).astype(np.int16)
with wave.open('music.wav','wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('ok')
