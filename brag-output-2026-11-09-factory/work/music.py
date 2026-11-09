import numpy as np, wave
SR=48000; DUR=23.0; N=int(SR*DUR); BEAT=.5; BAR=2.0
rng=np.random.default_rng(23)
f=lambda m:440*2**((m-69)/12)
buf=lambda:np.zeros(N)
def add(d,s,t,g=1.):
    i=int(round(t*SR)); j=min(N,i+len(s))
    if 0<=i<N: d[i:j]+=s[:j-i]*g
def env(n,a,d): x=np.arange(n)/SR; return np.minimum(1,x/max(a,1e-4))*np.exp(-x/d)
def lpf(x,c): X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(fr/c)**4); return np.fft.irfft(X,len(x))
def hpf(x,c): X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/np.sqrt(1+(c/np.maximum(fr,1))**4); return np.fft.irfft(X,len(x))
def saw(fr,n,det=0):
    x=np.arange(n)/SR; o=0
    for d in (-det,0,det): o=o+2*((x*fr*2**(d/1200)+rng.random())%1)-1
    return o/3
def tvlpf(x,c0,c1,blocks=40):  # time-varying lowpass via blocks
    out=np.zeros_like(x); L=len(x); hop=L//blocks+1
    for k in range(blocks):
        a=k*hop;b=min(L,a+2*hop)
        if a>=L: break
        w=np.hanning(b-a); c=c0*(c1/c0)**(k/blocks); out[a:b]+=lpf(x[a:b]*w,c)
    return out
def braam(n,g):
    s=sum(saw(f(m),n,10) for m in (38,45,50,53))/4
    s=tvlpf(s,250,2200)*env(n,.05,1.2); return np.tanh(s*2.5)*g
def boom(n=int(1.6*SR)):
    x=np.arange(n)/SR; return (np.sin(2*np.pi*np.cumsum(30+50*np.exp(-x*12))/SR)+.3*lpf(rng.standard_normal(n),300))*env(n,.002,.45)
def riser(len_s):
    n=int(len_s*SR); x=np.arange(n)/SR; return hpf(rng.standard_normal(n),1500)*(x/len_s)**3*.6+np.sin(2*np.pi*np.cumsum(200+600*(x/len_s)**2)/SR)*(x/len_s)**2*.15
def pluck(m,d=.18,n=int(.6*SR)):
    x=np.arange(n)/SR; return lpf(saw(f(m),n),2000)*env(n,.002,d)
chords=[[50,53,57],[46,50,53],[43,46,50],[45,49,52]]  # Dm Bb Gm A
roots=[38,34,31,33]
drone,drums,bass,ost,sfx=buf(),buf(),buf(),buf(),buf()
# drone D2+A2 throughout, swelling
n=N; x=np.arange(n)/SR
dr=lpf(saw(f(38),n,6)+saw(f(45),n,6)*.7,380)*np.minimum(1,x/1.5)
add(drone,dr,0,.10)
# half-time drums 3–19: kick on bar start, snare on beat 3 (t+1.0)
for bar in range(1,10):
    t=bar*BAR
    if 3<=t<19 or (t==2 and False):
        pass
for k in range(int(3/BEAT),int(19/BEAT)):
    t=k*BEAT; pos=(t%2)
    if abs(pos)<1e-6: add(drums,boom(int(.5*SR)),t,.55)
    if abs(pos-1)<1e-6:
        m=int(.4*SR); s=lpf(rng.standard_normal(m),3500)*env(m,.002,.11)+np.sin(2*np.pi*180*np.arange(m)/SR)*env(m,.002,.05)
        add(drums,s,t,.35)
# 16th pulse 3–19 (quiet hats)
for k in range(int(3/.125),int(19/.125)):
    t=k*.125; m=int(.03*SR); add(drums,hpf(rng.standard_normal(m),6000)*env(m,.0005,.008),t,.05 if k%2 else .08)
# bass: root eighths 3–19
for k in range(int(3/.25),int(19/.25)):
    t=k*.25; r=roots[int(t//BAR)%4]; m=int(.24*SR)
    add(bass,lpf(saw(f(r),m),260)*env(m,.004,.16),t,.42)
# ostinato from 7 to 19: eighth arpeggio
pat=[0,1,2,1]
for k in range(int(7/.25),int(19/.25)):
    t=k*.25; ch=chords[int(t//BAR)%4]; add(ost,pluck(ch[pat[k%4]]+12),t,.11)
# pads: chord swells per bar 3–19
for bar in range(1,10):
    t=bar*BAR
    if t<3 or t>=19: continue
    ch=chords[bar%4]; m=int(2.1*SR); xx=np.arange(m)/SR
    s=lpf(sum(saw(f(q),m,8) for q in ch)/3,900)*np.minimum(1,xx/.6)*np.minimum(1,(2.1-xx)/.4); add(drone,s,t,.07)
# hits / braams / risers
add(sfx,braam(int(2.6*SR),.5),0)
for t in (0,1,2): add(sfx,boom(),t,.75)
for t in (3,7,11,15): add(sfx,boom(),t,.6)
for t in (7,11,15,19): add(sfx,riser(1.0),t-1.0,.35)
add(sfx,braam(int(4*SR),.6),19)
add(sfx,boom(int(3*SR)),19,.9)
# refusal hit at 4.5: low D + A dissonance-free, muted
m=int(.8*SR); xx=np.arange(m)/SR
add(sfx,(np.sin(2*np.pi*f(38)*xx)+.5*lpf(saw(f(45),m),600))*env(m,.002,.25),4.5,.5)
def ping(mm,d=.9):
    m=int(2*SR); xx=np.arange(m)/SR; return (np.sin(2*np.pi*f(mm)*xx)+.4*np.sin(2*np.pi*f(mm)*2.76*xx)*np.exp(-xx*4))*env(m,.002,d)
add(sfx,ping(74),5.3,.12)   # booked
add(sfx,ping(81),9.0,.12)   # pool lands
for t in (8.25,8.75): m=int(.04*SR); add(sfx,hpf(rng.standard_normal(m),3000)*env(m,.001,.01),t,.25)
# DST flip 12.5: two ticks + swell
for t in (12.5,12.53): m=int(.04*SR); add(sfx,hpf(rng.standard_normal(m),2500)*env(m,.001,.012),t,.4)
m=int(1.5*SR); xx=np.arange(m)/SR; add(sfx,lpf(saw(f(57),m,12),1200)*np.sin(np.pi*xx/1.5),12.5,.12)
add(sfx,boom(int(1*SR)),17.5,.45); add(sfx,ping(62,1.2),17.5,.08)  # 23P01
ir_n=int(2.4*SR); ir=lpf(rng.standard_normal(ir_n)*np.exp(-np.arange(ir_n)/SR/.7),3000); ir/=np.sqrt((ir**2).sum())
def verb(x): L=len(x)+ir_n; return np.fft.irfft(np.fft.rfft(x,L)*np.fft.rfft(ir,L),L)[:len(x)]
mix=drone+drums+bass+ost+sfx+.3*verb(ost+sfx+drone*.5)
x=np.arange(N)/SR; m=x>21.0; fade=np.ones(N); fade[m]=np.cos((x[m]-21.0)/2.0*np.pi/2)**2
mix*=fade; mix=np.tanh(mix*1.2)/1.2; mix*=.89/np.abs(mix).max()
d=int(.013*SR); R=mix.copy(); R[d:]=mix[:-d]*.15+mix[d:]*.85
with wave.open('music.wav','wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.stack([mix,R],1)*32767).astype(np.int16).tobytes())
print('ok')
