from PIL import Image, ImageDraw, ImageFilter
import math, os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension', 'icons')
os.makedirs(OUT, exist_ok=True)

def lerp(a,b,t): return tuple(int(round(a[i]+(b[i]-a[i])*t)) for i in range(len(a)))

def bez(p0,p1,p2,steps=90):
    out=[]
    for i in range(steps+1):
        t=i/steps
        out.append(((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0],
                    (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1]))
    return out

def build(S, small):
    """Render the mark at S px. `small` = simplified, high-contrast toolbar variant."""
    img = Image.new('RGBA',(S,S),(0,0,0,0))
    grad = Image.new('RGBA',(S,S)); gd = ImageDraw.Draw(grad)
    top, bot = ((36,60,98) if small else (30,50,82)), (5,9,18)
    for y in range(S):
        gd.line([(0,y),(S,y)], fill=lerp(top,bot,y/(S-1))+(255,))
    mask = Image.new('L',(S,S),0)
    ImageDraw.Draw(mask).rounded_rectangle([0,0,S-1,S-1], radius=int(S*(0.30 if small else 0.229)), fill=255)
    img.paste(grad,(0,0),mask)

    def blur_layer(color, box, radius):
        l = Image.new('RGBA',(S,S),(0,0,0,0))
        ImageDraw.Draw(l).ellipse(box, fill=color)
        return l.filter(ImageFilter.GaussianBlur(radius))
    img = Image.alpha_composite(img, Image.composite(
        blur_layer((74,157,245,130), (-S*0.30,-S*0.45,S*0.80,S*0.40), S*0.10),
        Image.new('RGBA',(S,S),(0,0,0,0)), mask))

    # shield geometry — the small variant is fatter so it survives downscaling
    cx = S/2
    W = S*(0.78 if small else 0.615)
    H = S*(0.80 if small else 0.735)
    top_y = S*(0.105 if small else 0.135)
    left, right = cx-W/2, cx+W/2
    shoulder = top_y + H*(0.28 if small else 0.30)
    corner = W*(0.14 if small else 0.11)
    bottom = top_y + H

    pts = [(cx, top_y), (right-corner, top_y)]
    pts += bez((right-corner, top_y), (right, top_y), (right, top_y+corner))
    pts += [(right, shoulder)]
    pts += bez((right, shoulder), (right, top_y+H*0.80), (cx, bottom))
    pts += bez((cx, bottom), (left, top_y+H*0.80), (left, shoulder))
    pts += [(left, top_y+corner)]
    pts += bez((left, top_y+corner), (left, top_y), (left+corner, top_y))

    if not small:
        fill = Image.new('RGBA',(S,S),(0,0,0,0))
        ImageDraw.Draw(fill).polygon(pts, fill=(127,211,255,52))
        img = Image.alpha_composite(img, fill)

    stroke = Image.new('RGBA',(S,S),(0,0,0,0))
    sd = ImageDraw.Draw(stroke)
    lw = int(S*(0.115 if small else 0.032))
    sd.line(pts+[pts[0]], fill=(186,238,255,255) if small else (175,234,255,255), width=lw, joint='curve')
    stroke = stroke.filter(ImageFilter.GaussianBlur(S*(0.0 if small else 0.0016)))
    img = Image.alpha_composite(img, stroke)

    # snowflake
    fl = Image.new('RGBA',(S,S),(0,0,0,0))
    fd = ImageDraw.Draw(fl)
    fcx = cx
    fcy = top_y + H*(0.47 if small else 0.455)
    R = W*(0.36 if small else 0.315)
    LW = int(S*(0.115 if small else 0.0265))
    COL = (240,252,255,255)

    def seg(p,q,w,col):
        fd.line([p,q], fill=col, width=int(w))
        rr=w/2
        for pt in (p,q):
            fd.ellipse([pt[0]-rr,pt[1]-rr,pt[0]+rr,pt[1]+rr], fill=col)

    for k in range(3 if small else 6):
        a = math.radians(k*(60 if small else 60) - 90)
        dx,dy = math.cos(a), math.sin(a)
        if small:
            seg((fcx-dx*R,fcy-dy*R),(fcx+dx*R,fcy+dy*R), LW, COL)
        else:
            tip=(fcx+dx*R,fcy+dy*R)
            seg((fcx,fcy), tip, LW, COL)
            for off in (-52,52):
                b=math.radians(k*60-90+off)
                base=(fcx+dx*R*0.60, fcy+dy*R*0.60)
                bl=R*0.30
                seg(base,(base[0]+math.cos(b)*bl, base[1]+math.sin(b)*bl), LW*0.78, COL)

    # bright core so the mark reads at tiny sizes
    cr = R*(0.30 if small else 0.13)
    fd.ellipse([fcx-cr,fcy-cr,fcx+cr,fcy+cr], fill=(250,254,255,255))
    fl = fl.filter(ImageFilter.GaussianBlur(S*(0.0 if small else 0.0012)))
    img = Image.alpha_composite(img, fl)
    return img

master = build(2048, False)
master.save('/tmp/icon_master.png')
master.resize((128,128), Image.LANCZOS).save(f'{OUT}/icon128.png')
master.resize((48,48), Image.LANCZOS).save(f'{OUT}/icon48.png')
sm = build(512, True)
sm.resize((32,32), Image.LANCZOS).save(f'{OUT}/icon32.png')
sm.resize((16,16), Image.LANCZOS).save(f'{OUT}/icon16.png')
print('done')
