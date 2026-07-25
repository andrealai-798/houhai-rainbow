export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') return res.status(405).json({ error: '只允许 POST 请求' });

    try {
        const {
            name, progress, taskType, level,
            praises, advices,
            errorPrompt,    // 分类错误信息（单词/短语/句子）
            toneExamples,   // 语气参考例子
            styleExamples,  // 老师个人风格样本
            personal
        } = req.body;

        const systemPrompt = `你是一位资深、专业且极具亲和力的少儿英语教培机构"指导老师"。
请根据以下信息生成一段用于微信发送的"彩虹反馈段落"。

【极其重要的格式要求】：
1. 绝对不要输出"家长您好"、"请查收"、"以下是反馈"等任何开头！
2. 你的回复必须直接以学生的名字切入。
3. 所有标注的单词、短语、句子片段必须使用中文全角方括号【】标注。
4. 在星星系统下面的文字部分最好是两段话，不用分太多段。
5. 保证相邻的反馈都不要出现重复的话术。
6. 星星系统后的文字内容整体在150字以内。
7. 要注意相邻的反馈内容不要很接近。
8. 在文字内容中不要出现✨✨✨✨✨
9. 不要使用比喻句，比如像珍珠或者小溪
10. 不要再评价学生的发音像珍珠了，使用更多变的评价。

【错误反馈规则——极其重要，必须严格遵守】：
- 单词发音问题：多个单词时合并成一句，格式为「注意【单词1】、【单词2】、【单词3】的发音」，不要每个单词单独一句。如果某个单词有原因，在该单词后用括号补充，如「注意【fantastic】（i读成了e）、【hotel】的发音」。只有一个单词时正常写「注意【xxx】的发音」。绝对不要自己猜测或编造原因。
- 短语问题：如果有原因，说「【短语】+原因」；如果没有原因，只说「注意一下【短语】这个短语」，不要自己猜测原因。
- 句子问题：原因已由老师提供，必须针对该原因反馈，绝不能说「注意这句话的发音」，而要针对漏读或语法问题来说。

【内容基调要求】：
1. 遵循肯定亮点 + 温和建议 + 期待升华。
2. 根据作业等级调整语气：完美作业要自豪，错误适中要温和引导，攻坚挑战要共情打气。
3. 语气要口语化、亲切，适当使用Emoji。注意区分是朗读还是背诵。
4. 绝对不要用中文音译来纠音，只需要点出读错的单词即可。
5. ！！！【极度强调语言多样性与不可预测性】！！！：相邻生成的句式结构、引言、夸奖的角度必须完全不同！
6. 出现错误的单词，要生成跟着音频朗读3遍、巩固一下正确读音的建议。
7. 【鼓励方式多样化】：可以使用英文名言（如 "Every expert was once a beginner."），可以用比赛/游戏类比，可以用成长故事角度，可以直接热情鼓舞，可以用幽默轻松语气——每次选择不同的鼓励方式，绝对不要每次都用名言，也不要每次都用同一种风格。完美作业偏向认可与欣赏，错误适中偏向温和引导，攻坚挑战偏向共情与激励。`;

        // 盲盒机制：随机切入点（前端不可见，每次生成自动抽取）
        const BLIND_BOXES = [
            "【切入角度A：内容感知型】结合这篇课文的主题和场景，夸奖孩子读出了对应的场景感和情感。",
            "【切入角度C：情感态度型】重点夸奖孩子的精神面貌、自信心或认真努力的态度，从这个角度切入表扬。",
            "【切入角度D：细节放大型】重点夸奖孩子在语音语调或断句节奏上的专业表现，放大某个细节来赞美。",
        ];
        const blindBox = BLIND_BOXES[Math.floor(Math.random() * BLIND_BOXES.length)];

        // 构建语气参考段落
        const toneSection = toneExamples
            ? `\n【语气参考（请模仿以下风格，但不要直接照抄）】：\n${toneExamples}`
            : '';

        // 构建老师风格段落
        const styleSection = styleExamples && styleExamples.trim()
            ? `\n【这位老师的历史反馈样本——请深度学习她的语气、用词习惯、句式偏好，生成内容要尽量像这位老师说的话，但绝对不要直接照抄原句】：\n${styleExamples.trim()}`
            : '';

        const userPrompt = `学生英文名：${name || '未知'}
打卡进度：${progress || '未知'}
作业类型：${taskType || '未知'}
作业等级：${level || '未知'}
表现亮点：${praises || '无'}
建议指导：${advices || '无'}
错误标注（分类）：
${errorPrompt || '无'}
个性化观察/补充要求：${personal || '无'}${toneSection}${styleSection}
${blindBox}`;

        const response = await fetch("https://api.deepseek.com/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: "deepseek-v4-flash",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user",   content: userPrompt }
                ],
                temperature: 0.9,
                presence_penalty: 0.6,
                frequency_penalty: 0.5
            })
        });

        if (!response.ok) {
            const errData = await response.text();
            throw new Error(`DeepSeek API 报错: ${response.status} - ${errData}`);
        }

        const data = await response.json();
        res.status(200).json({ result: data.choices[0].message.content.trim() });

    } catch (error) {
        console.error("生成出错:", error);
        res.status(500).json({ error: error.message || '服务器内部错误' });
    }
}
