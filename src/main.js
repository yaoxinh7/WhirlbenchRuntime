import { Engine, Scene, Vector3, FreeCamera, HemisphericLight, MeshBuilder, StandardMaterial } from 'babylonjs';
import { SpriteStage } from './SpriteStage.js';





const stageWidth = 1920;
const stageHeight = 1080;


const canvas = document.getElementById('renderCanvas');
const ovrcanvas = document.getElementById('overlayCanvas');



// 阻止触摸事件的默认行为（滚动、缩放、长按菜单）
ovrcanvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
ovrcanvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
ovrcanvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
ovrcanvas.addEventListener('touchcancel', (e) => e.preventDefault(), { passive: false });

// 专门阻止长按上下文菜单
ovrcanvas.addEventListener('contextmenu', (e) => e.preventDefault());

const stageInputMetrics = {
    left: 0,
    top: 0,
    scaleX: 1,
    scaleY: 1,
    xScale: 1,
    yScale: 1
};
function updateStageInputMetrics() {
    const rect = ovrcanvas.getBoundingClientRect();
    const rectWidth = Math.max(1, rect.width || 1);
    const rectHeight = Math.max(1, rect.height || 1);
    const canvasWidth = Math.max(1, canvas.width || 1);
    const canvasHeight = Math.max(1, canvas.height || 1);
    stageInputMetrics.left = rect.left;
    stageInputMetrics.top = rect.top;
    stageInputMetrics.scaleX = canvasWidth / rectWidth;
    stageInputMetrics.scaleY = canvasHeight / rectHeight;
    stageInputMetrics.xScale = stageHeight / canvasWidth;
    stageInputMetrics.yScale = stageWidth / canvasHeight;
}
function getPointerClientXY(event) {
    if (event && typeof event.clientX === "number" && typeof event.clientY === "number") {
        return [event.clientX, event.clientY];
    }
    if (event && event.touches && event.touches[0]) {
        return [event.touches[0].clientX, event.touches[0].clientY];
    }
    if (event && event.changedTouches && event.changedTouches[0]) {
        return [event.changedTouches[0].clientX, event.changedTouches[0].clientY];
    }
    return [stageInputMetrics.left, stageInputMetrics.top];
}
// 获取舞台坐标的函数（你已定义，保持不变）
function getStageCoordinates(canvas, event) {
    // 获取 overlayCanvas 当前 CSS 布局位置
    const rect = ovrcanvas.getBoundingClientRect();
    const rectWidth = Math.max(1, rect.width);
    const rectHeight = Math.max(1, rect.height);

    // 获取 renderCanvas 当前像素尺寸（由 Babylon 引擎动态设置）
    const canvasWidth = Math.max(1, canvas.width);
    const canvasHeight = Math.max(1, canvas.height);

    const [clientX, clientY] = getPointerClientXY(event);

    // CSS 坐标相对于 overlayCanvas 左上角
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;

    // 转换为 renderCanvas 像素坐标
    const pixelX = cssX * (canvasWidth / rectWidth);
    const pixelY = cssY * (canvasHeight / rectHeight);

    // 映射到舞台逻辑坐标（原点在中心，舞台尺寸 480×360）
    const stageX = (pixelX - canvasWidth / 2) * (stageWidth / canvasWidth);
    const stageY = -(pixelY - canvasHeight / 2) * (stageHeight / canvasHeight);

    return [stageX, stageY];
}

// 全局变量
var mousex=0, mousey=0, mousep;

// 统一的事件处理函数
function handleMouseEvent(e) {
    mousep = getStageCoordinates(canvas, e);
    mousex = mousep[0];
    mousey = mousep[1];
    // 可选：打印坐标
    //console.log(`舞台坐标: (${mousex.toFixed(2)}, ${mousey.toFixed(2)})`);
}
updateStageInputMetrics();
window.addEventListener("scroll", updateStageInputMetrics, { passive: true });
if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateStageInputMetrics, { passive: true });
    window.visualViewport.addEventListener("scroll", updateStageInputMetrics, { passive: true });
}
if (window.PointerEvent) {
    ovrcanvas.addEventListener('pointermove', handleMouseEvent, { passive: true });
    ovrcanvas.addEventListener('pointerdown', handleMouseEvent, { passive: true });
} else {
    ovrcanvas.addEventListener('mousemove', handleMouseEvent, { passive: true });
    ovrcanvas.addEventListener('mousedown', handleMouseEvent, { passive: true });
    ovrcanvas.addEventListener('touchstart', handleMouseEvent, { passive: true });
    ovrcanvas.addEventListener('touchmove', handleMouseEvent, { passive: true });
}
ovrcanvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
});


const engine = new Engine(canvas, false);
const scene = new Scene(engine);

// 舞台逻辑尺寸（480x360，原点在中心）


// 正交相机
const camera = new FreeCamera('camera', new Vector3(0, 0, -10), scene);
camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = -stageWidth / 2;
camera.orthoRight = stageWidth / 2;
camera.orthoBottom = -stageHeight / 2;
camera.orthoTop = stageHeight / 2;
//控制
//camera.attachControl(canvas, true);
//取消控制
//camera.detachControl(canvas);
// 光源（方向设为0,0,0消除白线）


const light = new HemisphericLight('light', new Vector3(1, 1, 1), scene); // 光源放在上方
light.intensity = 5;

// 添加背景地面（位于精灵后方）
const ground = MeshBuilder.CreatePlane('ground', { width: stageWidth, height: stageHeight }, scene);
ground.position.z = 2; // 放在精灵后面
const groundMaterial = new StandardMaterial('groundMat', scene);
groundMaterial.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.2); // 深灰色背景
ground.material = groundMaterial;

// 初始化精灵舞台
const stage = new SpriteStage(scene);

// 创建精灵对象（图片放在 src/assets/ 下）
const cat = stage.createSprite('./assets/baba.png', -150, 100, 0, 80);
const dog = stage.createSprite('./assets/zhuti.png', 150, -80, Math.PI/4, 80);


















//初始函数写这里
//等待
function* sleepms(unlockt){
    while (Date.now()<unlockt){
        yield null;
    }
}

function* waituntil(unlockt){
    while (!waituntil){
        yield null;
    }
}


//计时器初始化


var timerstart=Date.now()/1000;


var varStage={"var1":0,"isclone":false};
var v_Stage_wodebianliang=varStage["var1"];
var shape=varStage["shape"];
var custom_names=["背景1"];
var custom_files=["cd21514d0531fdffb22204e0ec5ed84a.svg"];
var custom=0;
var xpos=undefined;
var ypos=undefined;
var size=undefined;
var direction=undefined;
import RUNTIME from "./runtime.js";
const runtime=new RUNTIME();
function* Stage(vardef) {
var events=[],ret=[];
function collectvars(){
    var collected={};
    collected["var1"]=v_Stage_wodebianliang;
    collected["isclone"]=true;
return collected; }
function collectfun(tag){
    var collected=[];
    return collected;
}


function* movetoms(x, y, duration) {
    var startX = xpos;
    var startY = ypos;
    var begint = Date.now();
    var endTime = begint + duration;
    var currentTime;
    while ((currentTime = Date.now()) < endTime) {
        var progress = (currentTime - begint) / duration;
        xpos = startX + (x - startX) * progress;
        ypos = startY + (y - startY) * progress;
        yield null;
    }
    xpos = x;
    ypos = y;
}


var isremove=false;

var tardx=stage.createSprite("./assets/"+custom_files[custom], xpos, ypos, direction, size);
var retevent={"msg":"ok","tardx":tardx};

while (true){
    yield retevent;//yield1
    events=yield {"ret":ret};
    ret=[];
    retevent=[];

    tardx.x=xpos;
    tardx.y=ypos;
    tardx.size=size;
    tardx.direction=direction;

    //retevent.push({"event":"pushtar","tardx":tardx});


    for (const event of events){
        if (event.id=="event"){
            retevent=collectfun(event.tag);
        }
        if (event.id=="remove"){
            if (vardef.isclone){
                isremove=true;
            }else{
                console.warn("不能结束母target的协程 否则其事件将无法触发!");
            }
        }
    }
    if (isremove){
        return retevent;
    }
    
}

                
}
function* jiaose1(vardef) {
var events=[],ret=[];
function collectvars(){
    var collected={};
    collected["isclone"]=true;
return collected; }
var pendown=false;
var xpos=-57.929286852155805;
var ypos=-7.804958221522745;
var size=100;
var direction=60;
var temp;
var temp1;
var temp2;
var custom_names=["造型1"];
var custom_files=["8aeaf393510963d2dd0b39aa7be455fd.png"];
var custom=0;
function* flagclick_1(){
    temp=0;
temp1=0;
if (pendown)
    stage.drawLine(xpos,ypos,temp,temp1);
xpos=temp;
ypos=temp1;
    direction=90;
    while (true){ //第1层
        var unlock_time=Date.now()+0.01*1000;
yield* sleepms(unlock_time);
        direction-=5;
if (direction>=180)
    direction-=360;
        var rad = (direction) * Math.PI / 180;
var stepx = (10) * Math.sin(rad);
var stepy = -(10) * Math.cos(rad);
if (pendown)
    stage.drawLine(xpos,ypos,xpos+stepx,ypos+stepy);
xpos+=stepx;
ypos+=stepy;
        yield null;
    } //第1层
}
function collectfun(tag){
    var collected=[];
    if (tag=="flag")
        collected.push(flagclick_1);
    return collected;
}


function* movetoms(x, y, duration) {
    var startX = xpos;
    var startY = ypos;
    var begint = Date.now();
    var endTime = begint + duration;
    var currentTime;
    while ((currentTime = Date.now()) < endTime) {
        var progress = (currentTime - begint) / duration;
        xpos = startX + (x - startX) * progress;
        ypos = startY + (y - startY) * progress;
        yield null;
    }
    xpos = x;
    ypos = y;
}


var isremove=false;

var tardx=stage.createSprite("./assets/"+custom_files[custom], xpos, ypos, direction, size);
var retevent={"msg":"ok","tardx":tardx};

while (true){
    yield retevent;//yield1
    events=yield {"ret":ret};
    ret=[];
    retevent=[];

    tardx.x=xpos;
    tardx.y=ypos;
    tardx.size=size;
    tardx.direction=direction;

    //retevent.push({"event":"pushtar","tardx":tardx});


    for (const event of events){
        if (event.id=="event"){
            retevent=collectfun(event.tag);
        }
        if (event.id=="remove"){
            if (vardef.isclone){
                isremove=true;
            }else{
                console.warn("不能结束母target的协程 否则其事件将无法触发!");
            }
        }
    }
    if (isremove){
        return retevent;
    }
    
}

                
}
function* jiaose2(vardef) {
var events=[],ret=[];
function collectvars(){
    var collected={};
    collected["isclone"]=true;
return collected; }
var pendown=false;
var xpos=-101.73517893192127;
var ypos=179.82033833296194;
var size=100;
var direction=136.91834826263758;
var temp;
var temp1;
var temp2;
var custom_names=["wb2","wb1"];
var custom_files=["734dcec51043b1f48964f64ab05313e5.svg","8fad50e6fd25ffef8f5ff6fc3b1b2c3d.svg"];
var custom=1;
function* flagclick_2(){
    temp=0;
temp1=0;
if (pendown)
    stage.drawLine(xpos,ypos,temp,temp1);
xpos=temp;
ypos=temp1;
    while (true){ //第1层
        temp=((mousex-xpos)/10);
if (pendown)
    stage.drawLine(xpos,ypos,xpos+temp,ypos);
xpos+=temp;
        temp=((mousey-ypos)/10);
if (pendown)
    stage.drawLine(xpos,ypos,xpos,ypos+temp);
ypos+=temp;
        direction-=((mousex-xpos)/10);
if (direction>=180)
    direction-=360;
        direction+=((mousey-ypos)/10);
if (direction<=-180)
    direction+=360;
        yield null;
    } //第1层
}
function* flagclick_3(){
    while (true){ //第1层
        custom++
if (custom+1>custom_files.length)
    custom=0
tardx.texture="./assets/"+custom_files[custom];
        var unlock_time=Date.now()+0.5*1000;
yield* sleepms(unlock_time);
        yield null;
    } //第1层
}
function collectfun(tag){
    var collected=[];
    if (tag=="flag")
        collected.push(flagclick_2);
    if (tag=="flag")
        collected.push(flagclick_3);
    return collected;
}


function* movetoms(x, y, duration) {
    var startX = xpos;
    var startY = ypos;
    var begint = Date.now();
    var endTime = begint + duration;
    var currentTime;
    while ((currentTime = Date.now()) < endTime) {
        var progress = (currentTime - begint) / duration;
        xpos = startX + (x - startX) * progress;
        ypos = startY + (y - startY) * progress;
        yield null;
    }
    xpos = x;
    ypos = y;
}


var isremove=false;

var tardx=stage.createSprite("./assets/"+custom_files[custom], xpos, ypos, direction, size);
var retevent={"msg":"ok","tardx":tardx};

while (true){
    yield retevent;//yield1
    events=yield {"ret":ret};
    ret=[];
    retevent=[];

    tardx.x=xpos;
    tardx.y=ypos;
    tardx.size=size;
    tardx.direction=direction;

    //retevent.push({"event":"pushtar","tardx":tardx});


    for (const event of events){
        if (event.id=="event"){
            retevent=collectfun(event.tag);
        }
        if (event.id=="remove"){
            if (vardef.isclone){
                isremove=true;
            }else{
                console.warn("不能结束母target的协程 否则其事件将无法触发!");
            }
        }
    }
    if (isremove){
        return retevent;
    }
    
}

                
}
function* jiaose3(vardef) {
var events=[],ret=[];
function collectvars(){
    var collected={};
    collected["isclone"]=true;
return collected; }
var pendown=false;
var xpos=3.4499999999999886;
var ypos=48.15;
var size=100;
var direction=102;
var temp;
var temp1;
var temp2;
var custom_names=["wb2","wb1"];
var custom_files=["734dcec51043b1f48964f64ab05313e5.svg","8fad50e6fd25ffef8f5ff6fc3b1b2c3d.svg"];
var custom=0;
function* flagclick_4(){
    while (true){ //第1层
        temp=runtime.randomBetween(-240,240);
temp1=runtime.randomBetween(-180,180);
yield* movetoms(temp,temp1,1000)
        yield null;
    } //第1层
}
function* flagclick_5(){
    while (true){ //第1层
        direction-=1;
if (direction>=180)
    direction-=360;
        var unlock_time=Date.now()+0.01*1000;
yield* sleepms(unlock_time);
        yield null;
    } //第1层
}
function collectfun(tag){
    var collected=[];
    if (tag=="flag")
        collected.push(flagclick_4);
    if (tag=="flag")
        collected.push(flagclick_5);
    return collected;
}


function* movetoms(x, y, duration) {
    var startX = xpos;
    var startY = ypos;
    var begint = Date.now();
    var endTime = begint + duration;
    var currentTime;
    while ((currentTime = Date.now()) < endTime) {
        var progress = (currentTime - begint) / duration;
        xpos = startX + (x - startX) * progress;
        ypos = startY + (y - startY) * progress;
        yield null;
    }
    xpos = x;
    ypos = y;
}


var isremove=false;

var tardx=stage.createSprite("./assets/"+custom_files[custom], xpos, ypos, direction, size);
var retevent={"msg":"ok","tardx":tardx};

while (true){
    yield retevent;//yield1
    events=yield {"ret":ret};
    ret=[];
    retevent=[];

    tardx.x=xpos;
    tardx.y=ypos;
    tardx.size=size;
    tardx.direction=direction;

    //retevent.push({"event":"pushtar","tardx":tardx});


    for (const event of events){
        if (event.id=="event"){
            retevent=collectfun(event.tag);
        }
        if (event.id=="remove"){
            if (vardef.isclone){
                isremove=true;
            }else{
                console.warn("不能结束母target的协程 否则其事件将无法触发!");
            }
        }
    }
    if (isremove){
        return retevent;
    }
    
}

                
}
var tarpool=[];
tarpool.push({"gen":Stage({"var1":0,"isclone":false}),"isclone":false,"name":"Stage","realname":"Stage"});
tarpool.push({"gen":jiaose1({"isclone":false}),"isclone":false,"name":"jiaose1","realname":"角色1"});
tarpool.push({"gen":jiaose2({"isclone":false}),"isclone":false,"name":"jiaose2","realname":"角色2"});
tarpool.push({"gen":jiaose3({"isclone":false}),"isclone":false,"name":"jiaose3","realname":"角色3"});


// 动画循环
`
engine.runRenderLoop(() => {
    // 简单移动
    //cat.x += 0.5;

    cat.x = mousex;
    cat.y = mousey;
    if (mousey > 0){
        cat.texture="./assets/zhuti.png";
        cat.direction+=0.05;
        cat.size=30;
    }else{
        cat.texture="./assets/baba.png";
        cat.direction-=0.05;
        cat.size=100;
    }
    stage.clearPen();
    stage.setPenSize(1);
    stage.setPenColor(0xff0000);
    stage.drawLine(0,0,mousex,mousey);
    stage.setPenColor(0x00ff00);
    stage.drawLine(dog.x,dog.y,cat.x,cat.y);

    dog.y += 0.3;
    dog.direction+=0.03;
    dog.size=Math.cos(dog.y/50)*25;
    if (dog.y > 150) dog.y = -150;

    // 渲染精灵（自动处理层级：数组后面的精灵覆盖前面的）
    stage.renderTick([dog,cat]);

    scene.render();
});

`
function renderf(poolx){
    stage.renderTick(poolx);
    scene.render();
}







// 窗口自适应（保持物理像素与显示尺寸匹配）
const stageRatio = stageWidth / stageHeight;

function resizeCanvas() {
    const container = document.getElementById('canvas-container');
    const renderCanvas = document.getElementById('renderCanvas');
    const overlayCanvas = document.getElementById('overlayCanvas');

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    if (containerWidth && containerHeight) {
        let drawWidth, drawHeight;
        const stageRatio = stageWidth/stageHeight; // 或者用已有的 stageWidth/stageHeight

        // 保持比例的尺寸计算（与原逻辑相同）
        const heightFromWidth = containerWidth / stageRatio;
        if (heightFromWidth <= containerHeight) {
            drawWidth = containerWidth;
            drawHeight = heightFromWidth;
        } else {
            drawHeight = containerHeight;
            drawWidth = containerHeight * stageRatio;
        }

        // 设置两个 canvas 的 CSS 尺寸
        renderCanvas.style.width = drawWidth + 'px';
        renderCanvas.style.height = drawHeight + 'px';
        overlayCanvas.style.width = drawWidth + 'px';
        overlayCanvas.style.height = drawHeight + 'px';

        // 设置物理像素尺寸（使用 devicePixelRatio 保证清晰）
        const dpr = window.devicePixelRatio || 1;
        renderCanvas.width = drawWidth * dpr;
        renderCanvas.height = drawHeight * dpr;
        overlayCanvas.width = drawWidth * dpr;
        overlayCanvas.height = drawHeight * dpr;
        if (typeof updateStageInputMetrics === "function") {
            updateStageInputMetrics();
        }
    }

    if (engine) engine.resize();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();















var tps=5;


var tickms=1000/tps;

if (tarpool.length<=0){
    console.error("没有正确拿到tarpool!");
    process.exit();
}


async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
var tarret;
var rendpool=[];

//target keys:  gen,isclone,father,name,realname,taskpool
//点绿旗
for (const target of tarpool){
    tarret=target.gen.next();
    if (tarret.value.msg != "ok"){
        console.error("target"+target.name+"初始化失败!");
        process.exit(1);
    }
    rendpool.push(tarret.value.tardx);
    var wantevent=[];
    wantevent.push({"id":"event","tag":"flag"})
    target.gen.next();
    tarret=target.gen.next(wantevent);
    console.log("角色"+target.name+"绿旗脚本数量"+tarret.value.length);
    target['taskpool']=[];
    for(const targen of tarret.value){
        //脚本任务 keys: gen,father,
        target['taskpool'].push({"gen":targen(),"father":"flag"});
    }
}
console.log(tarpool);
console.log("初始化完成辣!!!现在开始运行(");


var scriptreturn;
var miniscript=[];
var taskret;
var taskdel;
var task;
function steptick(){
    var tasksum=0;
    
    for (const target of tarpool){
        
        miniscript=target.taskpool;
        //脚本任务 keys: gen,father,
        
        for (let tid=0;tid < miniscript.length;tid++){
            task=miniscript[tid];
            tasksum++;
            taskret=task.gen.next();
            if (taskret.done){
                miniscript.splice(tid,1);
                tid--;
                tasksum--;
            }
        }
        //收集运行小脚本后获得的事件请求
        scriptreturn=target.gen.next();



        //向target发送任务请求
        tarret=target.gen.next([]);
        
        for(const targen of tarret.value){
            //创建任务
            target['taskpool'].push({"gen":targen(),"father":"flag"});
            tasksum++;
        }
        




    }
    if (tasksum == 0){
            console.log("看起来所有脚本都停掉了 那我也跑路喽~~~!!~~~")
            process.exit(0);
    }
    console.log("tick");
    renderf(rendpool);
}








//下面是TICK同步机



/**
 * 创建一个固定时间步长的 tick 调度器（适用于同步 step）
 * @param {Function} step - 你的同步 tick 函数
 * @param {number} tps - 每秒 tick 数（如 90）
 * @returns {Function} start 启动函数
 */
function createSyncTicker(step, tps) {
    const tickMs = 1000 / tps;
    let timeoutId = null;
    let stopped = false;

    function driver() {
        if (stopped) return;
        const startedAt = performance.now();
        step();
        const spent = performance.now() - startedAt;
        const wait = Math.max(0, tickMs - spent);
        timeoutId = setTimeout(driver, wait);
    }

    function start() {
        stopped = false;
        timeoutId = setTimeout(driver, 0);
    }

    function stop() {
        stopped = true;
        if (timeoutId) clearTimeout(timeoutId);
    }

    return { start, stop };
}

const ticker = createSyncTicker(steptick, 90);
ticker.start();
// 需要停止时调用 ticker.stop()
