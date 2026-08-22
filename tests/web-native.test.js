import test from"node:test";import assert from"node:assert/strict";
import{MAX_RANGE_BYTES,buildMediaPlans,extractVideoId,parseByteRange,safeFileName}from"../web/v1-core.js";

test("extractVideoId accepts supported YouTube URL shapes only",()=>{
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ"),"dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),"dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ"),"dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://evil.example/watch?v=dQw4w9WgXcQ"),null);
});
test("range parser hard caps gateway chunks",()=>{
  const r=parseByteRange("bytes=100-9999999",20_000_000);
  assert.equal(r.start,100);assert.equal(r.length,MAX_RANGE_BYTES);assert.equal(r.end,100+MAX_RANGE_BYTES-1);
});
test("range parser rejects suffix and out-of-range requests",()=>{
  assert.throws(()=>parseByteRange("bytes=-500",1000),RangeError);
  assert.throws(()=>parseByteRange("bytes=1000-",1000),RangeError);
});
test("buildMediaPlans prefers progressive mp4 then split plan",()=>{
  const formats=[
    {itag:18,height:360,has_video:true,has_audio:true,mime_type:"video/mp4",content_length:10,bitrate:1},
    {itag:137,height:1080,has_video:true,has_audio:false,mime_type:"video/mp4",content_length:20,bitrate:3},
    {itag:140,has_video:false,has_audio:true,mime_type:"audio/mp4",content_length:5,bitrate:2}
  ];
  const p=buildMediaPlans(formats);
  assert.deepEqual(p.mp4Plans.map(x=>[x.quality,x.mode]),[[360,"direct"],[1080,"mux"]]);
  assert.equal(p.audioPlan.itag,140);
});
test("safeFileName strips path separators and reserved names",()=>{
  assert.equal(safeFileName("../../bad\\name?.mp3"),".. .. bad name .mp3");
  assert.equal(safeFileName("CON","media"),"media");
});
