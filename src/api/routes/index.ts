import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import chat from "./chat.ts";
import images from "./images.ts";
import models from "./models.ts";
import ping from "./ping.ts";
import token from './token.ts';

export default [
    {
        get: {
            '/': async () => {
                let content;
                try {
                    content = await fs.readFile('public/welcome.html');
                } catch (err) {
                    // exe 打包场景无独立 public 目录，返回内联欢迎页
                    content = Buffer.from(
                        '<h1>qwen-free-api</h1><p>Service is running.</p>'
                    );
                }
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            }
        }
    },
    chat,
    images,
    models,
    ping,
    token
];