import numpy as np, wave
SR=48000; DUR=23.0; N=int(SR*DUR); BEAT=0.5; BAR=2.0
rng=np.random.default_rng(5)
f=lambda m:440*2**((m-69)/12)
buf=lambda:np.zeros(N)
def add(d,s,t,g=1.0):
    i=int(round(t*SR)); j=min(N,i+len(s))
    if i<N: d[i:j]+=s[:j-i]*g
def env(n,a,d): x=np.arange(n)/SR; return np.minimum(1,x/max(a,1e-4))*np.exp(-x/d)
def lpf(x,c): X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(fr/c)**4); return np.fft.irfft(X,len(x))
def hpf(x,c): X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(c/np.maximum(fr,1))**4); return np.fft.irfft(X,len(x))
def mar(m,d=.35,n=None):  # marimba: fundamental + 4x and 10x partials, fast decay on the overtones
    n=n or int(1.2*SR); x=np.arange(n)/SR; fr=f(m)
    return (np.sin(2*np.pi*fr*x)*env(n,.002,d)+.25*np.sin(2*np.pi*fr*3.93*x)*env(n,.001,.04)+.08*np.sin(2*np.pi*fr*9.9*x)*env(n,.001,.015))
chords=[[67,71,74],[64,67,71],[60,64,67],[62,66,69]]  # G Em C D
roots=[43,40,36,38]
drums,bass,keys,sfx=buf(),buf(),buf(),buf()
for b in range(int(20/BEAT)):
    t=b*BEAT
    if b%2==0: n=int(.35*SR); x=np.arange(n)/SR; add(drums,np.sin(2*np.pi*np.cumsum(48+80*np.exp(-x*32))/SR)*env(n,.002,.11),t,.7)
    if b%4 in(1,3) and t>=2: n=int(.25*SR); add(drums,lpf(hpf(rng.standard_normal(n),900),4000)*env(n,.002,.045),t,.25)
    if t>=2: n=int(.04*SR); add(drums,hpf(rng.standard_normal(n),6000)*env(n,.001,.01),t+.25,.08)
for k in range(int(20/0.5)):
    t=k*.5; r=roots[int(t//BAR)%4]; n=int(.45*SR); x=np.arange(n)/SR
    add(bass,lpf(np.sin(2*np.pi*f(r)*x)+.25*np.sin(4*np.pi*f(r)*x),350)*env(n,.008,.25),t,.5 if t>=2 else .3)
pat=[0,2,1,2,0,2,1,2,0,1,2,1,0,2,1,2]
for k in range(int(20/0.25)):
    t=k*.25; ch=chords[int(t//BAR)%4]; m=ch[pat[k%16]]+12
    if t>=2 or k%2==0: add(keys,mar(m,.22),t,.10 if k%2==0 else .055)
for bar in range(10):  # soft pad under it
    ch=chords[bar%4]; n=int(2.1*SR); x=np.arange(n)/SR
    s=sum(np.sin(2*np.pi*f(m)*x)+.3*np.sin(4*np.pi*f(m)*x) for m in ch)/3*np.minimum(1,x/.3)*np.minimum(1,(2.1-x)/.3)
    add(keys,lpf(s,1500),bar*2,.05)
# SFX in G
add(sfx,mar(79),.5,.22); add(sfx,mar(83),1.0,.22)                  # cards land
n=int(.3*SR); add(sfx,lpf(np.sin(2*np.pi*f(50)*np.arange(n)/SR),600)*env(n,.002,.08),4.0,.5)  # refusal tock
add(sfx,mar(74),5.0,.18); add(sfx,mar(79),5.25,.18)               # waitlist
for t in (8,12,16,20): n=int(.35*SR); x=np.arange(n)/SR; add(sfx,lpf(rng.standard_normal(n),2500)*(x/.35)**2,t-.35,.06)  # slide swish
add(sfx,mar(71),9.0,.16); add(sfx,mar(67),9.25,.16)               # cancel, falling
add(sfx,mar(74),10.0,.2); add(sfx,mar(79),10.25,.2); add(sfx,mar(83),10.5,.16)  # hold to next in line, rising
for m in (79,83,86): add(sfx,mar(m),13.0,.13)                    # booked together
n=int(.3*SR); add(sfx,lpf(np.sin(2*np.pi*f(50)*np.arange(n)/SR),600)*env(n,.002,.08),17.5,.4)  # released
add(sfx,mar(74),18.5,.2); add(sfx,mar(79),18.75,.2)               # offered on
for i,m in enumerate((55,67,71,74,81)):                           # outro bell, G add9
    n=int(3*SR); x=np.arange(n)/SR; add(sfx,(np.sin(2*np.pi*f(m)*x)+.2*np.sin(2*np.pi*f(m)*3*x))*env(n,.003,1.3),20+i*.04,.09)
ir_n=int(1.2*SR); ir=lpf(rng.standard_normal(ir_n)*np.exp(-np.arange(ir_n)/SR/.3),4500); ir/=np.sqrt((ir**2).sum())
def verb(x): L=len(x)+ir_n; return np.fft.irfft(np.fft.rfft(x,L)*np.fft.rfft(ir,L),L)[:len(x)]
mix=drums+bass+keys+sfx+.2*verb(keys+sfx)
x=np.arange(N)/SR; m=x>21.4; fade=np.ones(N); fade[m]=np.cos((x[m]-21.4)/1.6*np.pi/2)**2
mix*=fade; mix=np.tanh(mix*1.3)/1.3; mix*=.89/np.abs(mix).max()
d=int(.01*SR); R=mix.copy(); R[d:]=mix[:-d]*.15+mix[d:]*.85
with wave.open('music.wav','wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.stack([mix,R],1)*32767).astype(np.int16).tobytes())
print('ok')
