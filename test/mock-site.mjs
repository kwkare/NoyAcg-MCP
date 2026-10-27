/**
 * 假站点：按 noymanga.com 的真实契约返回数据，用于集成测试。
 * 只实现本项目用到的端点，行为照着 docs/ 里实测过的结果写。
 */
import { createServer } from "node:http";

const nowSec = () => Math.floor(Date.now() / 1000);

export async function startMockSite() {
  const state = {
    uid: 12345,
    username: "tester",
    integral: 100,
    show: ["10", "8"],
    badges: [
      { Id: 8, Name: "諾莉亞的凝視", Img: "https://bucket.test/image/nry-bge.webp", Minimg: "", Des: "积分很高的人才有" },
      { Id: 9, Name: "丸", Img: "https://bucket.test/image/maru.webp", Minimg: "", Des: "丸" },
      { Id: 10, Name: "100 天簽到紀念", Img: "https://bucket.test/image/100d.webp", Minimg: "", Des: "签到 100 天" },
      { Id: 12, Name: "5st 紀念徽章 H", Img: "https://bucket.test/image/5sth.webp", Minimg: "", Des: "纪念" },
    ],
    posts: [
      {
        id: 78930,
        uid: 12345,
        username: "tester",
        title: "图",
        content: "[noygirl:yeah]",
        image: ["image/a.webp"],
        spoiler: "0",
        time: nowSec() - 600,
        expired: nowSec() + 7_000_000,
        like: 0,
        reply: 1,
        is_like: false,
        area: "Japan",
        platform: "web",
        edit: 0,
        su: 0,
      },
    ],
    comments: [
      {
        rid: 460550,
        cid: 78930,
        uid: 777,
        username: "other",
        content: "妈妈",
        reply_id: -1,
        root_id: 0,
        reply_num: 0,
        replies: [],
        time: nowSec() - 300,
        area: "Japan",
        platform: "web",
      },
    ],
    avatar: "avatar/12345-old.webp",
    bg: "bg/12345-old.webp",
    nextPostId: 79000,
    nextRid: 500000,
    today: false,
    continuous: 10,
    records: [{ id: 1, uid: 12345, continuous: 10, ip: "0.0.0.0", time: `${new Date().toISOString().slice(0, 10)}T00:00:00+08:00`, weekday: 2 }],
    calls: [],
  };

  const json = (res, payload) => {
    res.writeHead(200, { "content-type": "application/json;charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

  const asForm = (body) => Object.fromEntries(new URLSearchParams(body));

  const topComments = (postId) =>
    state.comments.filter((c) => c.cid === Number(postId) && c.reply_id === -1);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname;
    const body = await readBody(req);
    state.calls.push({ path, body });

    // 需要登录的端点：没 cookie 一律 status=login（和真站点一致）
    const authed = String(req.headers.cookie ?? "").includes("NOY_SESSION=");
    const publicPaths = new Set(["/api/logout", "/api/upload_image", "/api/upload_avatar", "/api/upload_bg"]);
    if (!authed && path.startsWith("/api/") && !publicPaths.has(path)) {
      return json(res, { status: "login" });
    }

    // ---------------------------------------------------------------- 用户
    if (path === "/api/v3/userinfo") {
      return json(res, {
        status: "ok",
        userinfo: {
          Email: "tester@example.com",
          Integral: state.integral,
          Time: 1655471118,
          Uhash: "12345a",
          Uid: state.uid,
          Username: state.username,
          Avatar: state.avatar,
          Bg: state.bg,
          CommentLen: 0,
          Badge: state.badges.map((b) => ({ ...b, Id: 0 })),
          Su: 0,
        },
      });
    }
    if (path === "/api/badge") return json(res, { status: "ok", data: state.badges, show: state.show });
    if (path === "/api/v3/set_badge_show") {
      const id = asForm(body).id;
      const index = state.show.indexOf(id);
      if (index >= 0) state.show.splice(index, 1);
      else state.show.push(id);
      return json(res, { status: "ok" });
    }

    // ---------------------------------------------------------------- 首页
    if (path === "/api/home") {
      const book = (bid, name) => ({
        Bid: bid,
        Mode: 1,
        Bookname: name,
        alias: "",
        Description: "",
        Author: "作者",
        Pname: "未知",
        Ptag: "搞笑 校園",
        Otag: "原創",
        Time: nowSec() - 1000,
        Views: 100,
        Favorites: 50,
        F: false,
        Len: 1,
        Adult: 0,
        Status: 0,
        publish_year: "",
        RatingSUM: 0,
        RatingCount: 0,
        RatingBayes: 0,
      });
      return json(res, {
        status: "ok",
        bulletin: { text: "點擊廣告，救救Noy！", show: true },
        favDay: [book(1, "腦洞學生會"), book(2, "另一本")],
        readDay: [book(3, "第三本")],
        fs: [book(4, "第四本")],
        proportion: [book(5, "第五本")],
        stream: [{ sid: 100, name: "學生會也有洞！", des: "简介", tags: "校園", pages: "", type: 0, count: 4, time: nowSec(), up_time: nowSec(), f: false, views: 438, favorites: 35 }],
        tags: ["冒險", "奇幻"],
      });
    }
    if (path === "/api/v3/ads") return json(res, { status: "ok", data: [{ img: "https://bucket.test/image/ad.webp", url: "https://example.com" }] });

    // ---------------------------------------------------------------- 社区
    if (path === "/api/v3/community_list") {
      const page = Number(asForm(body).page ?? 1);
      return json(res, { status: "ok", info: state.posts, len: state.posts.length, over: page >= 1, top: page === 1 });
    }
    const detail = path.match(/^\/api\/v4\/community\/post\/(\d+)$/);
    if (detail) {
      const post = state.posts.find((p) => p.id === Number(detail[1]));
      if (!post) return json(res, { status: "ok", data: { post: {}, comments: [], comment_count: 0, top_count: 0, uid: state.uid } });
      return json(res, {
        status: "ok",
        data: {
          post,
          comments: topComments(post.id).sort((a, b) => b.time - a.time),
          comment_count: topComments(post.id).length,
          top_count: 0,
          uid: state.uid,
        },
      });
    }
    const commentsPath = path.match(/^\/api\/v4\/community\/post\/(\d+)\/comments$/);
    if (commentsPath) {
      return json(res, {
        status: "ok",
        data: {
          comments: topComments(commentsPath[1]),
          page: Number(asForm(body).page ?? 1),
          over: true,
          top_count: 0,
        },
      });
    }
    const repliesPath = path.match(/^\/api\/v4\/community\/post\/(\d+)\/comment\/(\d+)\/replies$/);
    if (repliesPath) {
      const parent = state.comments.find((c) => c.rid === Number(repliesPath[2]));
      return json(res, {
        status: "ok",
        data: { count: parent?.replies.length ?? 0, over: true, page: 1, replies: parent?.replies ?? [] },
      });
    }

    const replyPath = path.match(/^\/api\/v4\/community\/post\/(\d+)\/reply$/);
    if (replyPath) {
      const form = asForm(body);
      const postId = Number(replyPath[1]);
      const post = state.posts.find((p) => p.id === postId);
      const replyTo = Number(form.reply_id ?? -1);
      const target = state.comments.find((c) => c.rid === replyTo);
      const root = replyTo === -1 ? 0 : (target?.root_id || replyTo);
      const comment = {
        rid: state.nextRid++,
        cid: postId,
        uid: state.uid,
        username: state.username,
        content: form.text,
        reply_id: replyTo,
        root_id: root,
        reply_num: 0,
        replies: [],
        time: nowSec(),
        area: "Japan",
        platform: form.platform ?? "web",
        reply_uid: target?.uid,
        reply_username: target?.username,
        reply: target?.content,
      };
      if (target) {
        target.replies.push(comment);
        target.reply_num += 1;
      }
      state.comments.push(comment);
      if (post) post.reply += 1;
      return json(res, { status: "ok" });
    }

    if (path === "/api/v3/community_like") {
      const post = state.posts.find((p) => p.id === Number(asForm(body).cid));
      if (post) {
        post.is_like = !post.is_like;
        post.like += post.is_like ? 1 : -1;
      }
      return json(res, { status: "ok", is_like: post?.is_like ?? true });
    }

    if (path === "/api/v3/send_community") {
      const form = asForm(body);
      const post = {
        id: state.nextPostId++,
        uid: state.uid,
        username: state.username,
        title: form.title,
        content: form.content,
        image: form.image ? JSON.parse(form.image) : [],
        spoiler: "",
        time: nowSec(),
        expired: nowSec() + 7_776_000,
        like: 0,
        reply: 0,
        is_like: false,
        area: "Japan",
        platform: form.platform ?? "web",
        edit: 0,
        su: 0,
      };
      state.posts.unshift(post);
      return json(res, { status: "ok" });
    }

    if (path === "/api/v3/edit_community_post") {
      const form = asForm(body);
      const post = state.posts.find((p) => p.id === Number(form.id));
      if (post) {
        post.title = form.title;
        post.content = form.content;
        post.edit = nowSec();
      }
      return json(res, { status: "ok" });
    }

    // ---------------------------------------------------------------- 签到
    if (path === "/api/v4/signin/record") {
      return json(res, {
        status: 200,
        today: state.today,
        continuous: state.today ? state.continuous : -1,
        data: state.today ? state.records : [],
      });
    }
    if (path === "/api/v4/signin/sign") {
      if (state.today) return json(res, { status: 500, msg: "Please do not sign in too frequently" });
      state.today = true;
      state.continuous += 1;
      state.integral += 1;
      state.records.unshift({ id: 2, uid: state.uid, continuous: state.continuous, ip: "0.0.0.0", time: `${new Date().toISOString().slice(0, 10)}T00:00:00+08:00`, weekday: 3 });
      return json(res, { status: 200, continuous: state.continuous, msg: "success" });
    }

    // ---------------------------------------------------------------- 讯息
    if (path === "/api/v4/msg/count") {
      return json(res, { status: "ok", count: { all: 1, sys_msg: 0, community_reply: 1, comment_reply: 0 } });
    }
    if (path === "/api/v3/get_msg") {
      const type = asForm(body).type;
      if (type === "reply") {
        return json(res, { status: "ok", reply: { book: {}, comment: [], commentLen: 0, count: 0 } });
      }
      if (type === "community_reply") {
        return json(res, {
          status: "ok",
          community_reply: {
            community: { "78930": { id: 78930, title: "图" } },
            community_reply: [
              { rid: 460600, uid: 777, cid: 78930, username: "other", avatar: "", avatarUrl: "avatar/777-x.webp", area: "Japan", reply: -1, reply_text: "", platform: "", time: nowSec() - 60, content: "不错" },
            ],
            community_reply_len: 1,
            count: 1,
          },
        });
      }
      return json(res, { status: "ok", sysmsg: { count: 0, len: 0, msg: [] } });
    }

    if (path === "/api/logout") return json(res, { status: "logout" });

    // ---------------------------------------------------------------- 图床
    if (path === "/api/get_image_bucket_token") return json(res, { status: "ok", token: "tok-123==" });
    if (path === "/api/upload_avatar" || path === "/api/upload_bg") {
      const file = "12345-deadbeef.webp";
      if (path.endsWith("avatar")) state.avatar = `avatar/${file}`;
      else state.bg = `bg/${file}`;
      // 真站点就是这个形态：只有 status，没有 file
      return json(res, { status: "ok" });
    }
    if (path === "/api/upload_image") {
      const hasFile = body.includes('name="file"');
      return json(res, { status: hasFile ? "ok" : "token_format_error", file: "12345-deadbeef.webp" });
    }

    return json(res, { status: "login" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}
