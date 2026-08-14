// 等待指定时间后继续
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调用 DeepSeek，并在服务器繁忙时自动重试。
 *
 * 最多请求 3 次：
 * 第一次失败后等待 2 秒；
 * 第二次失败后等待 5 秒；
 * 第三次仍失败才返回错误。
 */
async function callDeepSeekWithRetry(requestBody) {
    const MAX_ATTEMPTS = 3;

    // 这些错误通常属于暂时性问题，可以自动重试
    const RETRYABLE_STATUS = new Set([
        429, // 请求过于频繁
        500, // DeepSeek 内部错误
        502, // 上游服务错误
        503, // DeepSeek 服务器繁忙
        504  // 请求超时
    ]);

    // 第一次失败等 2 秒，第二次失败等 5 秒
    const RETRY_DELAYS = [0, 2000, 5000];

    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();

        // 单次请求超过 30 秒就主动停止，避免一直等到 Vercel 300 秒超时
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, 30000);

        let response;
        let rawText = '';
        let attemptError;

        try {
            response = await fetch(
                'https://api.deepseek.com/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                }
            );

            // 先按普通文字读取，便于保留 DeepSeek 的错误信息
            rawText = await response.text();

        } catch (error) {
            if (error.name === 'AbortError') {
                attemptError = new Error('DeepSeek 单次请求超过 30 秒');
                attemptError.status = 504;
            } else {
                attemptError = new Error(
                    `连接 DeepSeek 失败：${error.message}`
                );
                attemptError.status = 503;
            }
        } finally {
            clearTimeout(timeoutId);
        }

        // 成功联系到 DeepSeek 后，检查它返回的状态
        if (!attemptError && response) {
            if (!response.ok) {
                attemptError = new Error(
                    `DeepSeek API 报错：${response.status} - ${rawText.slice(0, 800)}`
                );
                attemptError.status = response.status;

            } else {
                let data;

                try {
                    data = JSON.parse(rawText);
                } catch (error) {
                    attemptError = new Error('DeepSeek 返回的数据无法解析');
                    attemptError.status = 502;
                }

                if (!attemptError) {
                    const content =
                        data?.choices?.[0]?.message?.content?.trim();

                    if (content) {
                        // 成功获得反馈，立即结束重试
                        return content;
                    }

                    attemptError = new Error(
                        'DeepSeek 没有返回有效的反馈文字'
                    );
                    attemptError.status = 502;
                }
            }
        }

        lastError = attemptError;

        const status = Number(attemptError?.status);
        const canRetry = RETRYABLE_STATUS.has(status);

        // 400、401、402、422 等错误不适合盲目重试
        if (!canRetry || attempt === MAX_ATTEMPTS) {
            throw lastError;
        }

        const delay = RETRY_DELAYS[attempt];

        console.warn(
            `DeepSeek 第 ${attempt} 次请求失败，状态 ${status}，` +
            `${delay / 1000} 秒后自动重试`
        );

        await sleep(delay);
    }

    throw lastError || new Error('DeepSeek 请求失败');
}
module.exports = async function handler(req, res) {
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
    errorItems,
    toneExamples,
    personal
    } = req.body;
        
        const wordItems = Array.isArray(errorItems?.word)
    ? errorItems.word
    : [];

const phraseItems = Array.isArray(errorItems?.phrase)
    ? errorItems.phrase
    : [];


// 单词问题：老师填写的原因原样保留
const lockedWordText = wordItems.length
    ? wordItems.map(i => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        const isPartialLetters =
            /^(?=.*-)[A-Za-z-]+$/.test(reason);

        return reason
            ? `【${text}】${isPartialLetters ? '的' : ''}${reason}`
            : `【${text}】`;
    }).join('、')
    : '';


// 短语 / 句子问题：老师填写的原因原样保留
const lockedPhraseText = phraseItems.length
    ? phraseItems.map(i => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        return `【${text}】${reason}`;
    }).join('、')
    : '';

        const systemPrompt = `你是一位资深、专业且极具亲和力的少儿英语教培机构"指导老师"。
请根据以下信息生成一段用于微信发送的"彩虹反馈段落"。

【极其重要的格式要求】：
1. 绝对不要输出"家长您好"、"请查收"、"以下是反馈"等任何开头！
2. 你的回复必须直接以学生的名字切入。
3. 所有标注的单词、短语、句子片段必须使用中文全角方括号【】标注。
4. 在星星系统下面的文字部分最好是两段话，不用分太多段。
5. 相邻反馈应适当变化开头、句式和夸奖角度，但自然优先，不要为了避免重复而刻意创造新奇表达。
6. 星星系统后的文字整体尽量控制在150字以内。
如果老师锁定的知识点较多，必须优先完整保留老师输入内容，
不能为了控制字数删减或改写知识点。
7. 在文字内容中不要出现✨✨✨✨✨
8. 不要使用比喻句，比如像珍珠或者小溪

【老师知识点使用规则——最高优先级】：
老师填写的具体知识点会通过 [[WORD_ERRORS]] 和 [[PHRASE_ERRORS]] 插入。
- [[WORD_ERRORS]] 代表老师标注的单词发音问题。
- [[PHRASE_ERRORS]] 代表老师标注的短语、句子、语法或其他结构问题。
必须完整使用所有存在的占位符，DeepSeek 可以根据上下文添加自然的连接语和反馈语言，但老师提供的具体知识点内容本身必须保持不变。例如可以在知识点前后自然加入“再留意一下”“这里可以再巩固”等表达，但不能改写知识点本身。不能遗漏、改写、概括或自行解释老师提供的具体知识点，也不要重复反馈同一个知识点。
请根据知识点的类别自然组织语言：
- 单词问题自然归入发音方面进行总结；
- 短语、句子、语法问题根据老师提供的原因，自然归入语法结构、漏读、表达等相应方面。
不要机械罗列“单词问题”“短语问题”等标签，也不要套固定句型。要像真实老师给家长写微信反馈一样，自然地把知识点融入完整句子中。
不要在 [[WORD_ERRORS]] 或 [[PHRASE_ERRORS]] 外额外添加【】；【】只用于老师提供的具体单词、短语或句子，不要自行创造【出现问题的单词】【这些单词】等概括性标注。

【反馈内容顺序】：
先自然肯定学生本次作业的整体表现和亮点，再根据老师提供的知识点，自然总结具体问题。若同时存在单词发音问题和短语/句子/语法问题，要让两类问题在表达上有清楚的区分，但不需要使用固定小标题或固定句型。
所有具体问题反馈完成后，再统一给出与问题类型对应的练习建议；练习建议之后，用1-2句简短、自然的鼓励或期待收尾。
整体要自然衔接，不要为了遵守顺序而写成机械模板。

【内容基调要求】：
1. 遵循肯定亮点 + 温和建议 + 期待升华。
2. 根据作业等级调整语气：完美作业要自豪，错误适中要温和引导，攻坚挑战要共情打气。
3. 语气要自然、亲切、口语化，但必须符合老师给家长发送微信反馈的表达习惯。可以轻松活泼，但不要使用网络化、夸张、刻意搞笑或过度拟人化的表达。适当使用Emoji。注意区分是朗读还是背诵。
4. 绝对不要用中文音译来纠音，只需要点出读错的单词即可。
5. 【保持表达多样，但自然优先】：相邻反馈可以适当变化句式、开头和夸奖角度，但不要为了追求不同而使用生硬、夸张或少见的表达。自然、清楚、像真实老师说话，优先级高于语言新奇。
6. 【针对性练习建议】：
- 如果有单词发音问题，在所有具体问题反馈完成后，必须自然加入练习建议：跟着示范音频将相关单词读5遍，巩固正确读音。
- 如果有短语、句子或语法结构问题，在所有具体问题反馈完成后，必须自然加入练习建议：将对应的语法点、短语或句子回归原句读3遍，加深对结构和用法的理解。
- 如果两类问题同时存在，两项练习都必须包含，可以自然合并成一句或前后衔接。
- 如果只有一类问题，只给对应的练习建议。
- 练习建议统一放在所有具体问题之后、最后一句鼓励之前，不要穿插在问题反馈中。
- 可以自然变化句式，但必须保留“示范音频 + 单词 + 5遍”和“回归原句 + 语法/短语/句子 + 3遍”的核心信息。
- 次数统一写作“5遍”“3遍”。
7. 【结尾鼓励】：
练习建议之后，只保留1-2句简短、自然的鼓励或期待作为结尾。不要再次总结前面的表现，不要重复知识点或练习建议，也不要连续写多句内容很接近的鼓励。
结尾可以活泼、有亲和力，但要简洁收住。
8. 【鼓励方式多样化】：可以从认可进步、肯定认真程度、鼓励继续练习、期待下一次表现等不同角度进行鼓励，也可以偶尔使用简短英文鼓励语。语言可以活泼、生动、有亲和力，也可以适当加入轻松幽默的表达，但要符合真实老师给家长反馈的语境，避免过度夸张、过于网络化、过分新奇或让人觉得突兀的说法。
9. 【语言自然度要求】：反馈要像真实老师写给家长的微信内容。可以自然活泼、适度生动，但不要为了追求特别而使用过度夸张、网络化或让人感觉突兀的表达，例如“抠一抠”“焊在嘴巴里”等。涉及练习时，优先使用“再练一练”“再巩固一下”“注意读清楚”“跟着音频再读几遍”等自然表达。
10. 不要自行创造【出现问题的单词】【这些单词】【错误单词】等概括性方括号内容；【】中只能放老师提供的具体单词、短语或句子。`;

        // 构建语气参考段落
        const toneSection = toneExamples
            ? `\n【语气参考（请模仿以下风格，但不要直接照抄）】：\n${toneExamples}`
            : '';

        const userPrompt = `学生英文名：${name || '未知'}
打卡进度：${progress || '未知'}
作业类型：${taskType || '未知'}
作业等级：${level || '未知'}
表现亮点：${praises || '无'}
建议指导：${advices || '无'}
错误标注（分类）：
单词发音问题：${lockedWordText ? '[[WORD_ERRORS]]' : '无'}
短语/句子问题：${lockedPhraseText ? '[[PHRASE_ERRORS]]' : '无'}
个性化观察/补充要求：${personal || '无'}${toneSection}`;

    let result = await callDeepSeekWithRetry({
    model: "deepseek-v4-flash",

    thinking: {
        type: "disabled"
    },

    messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ],

    temperature: 0.7,
    max_tokens: 500
});

// 防止 AI 给占位符额外套上【】
result = result
    .replaceAll('【[[WORD_ERRORS]]】', '[[WORD_ERRORS]]')
    .replaceAll('【[[PHRASE_ERRORS]]】', '[[PHRASE_ERRORS]]');
// 插入老师原始填写的单词问题
if (lockedWordText) {
    if (result.includes('[[WORD_ERRORS]]')) {
        result = result.replace('[[WORD_ERRORS]]', lockedWordText);

        // 如果 AI 意外重复输出占位符，删除多余的
        result = result.replaceAll('[[WORD_ERRORS]]', '');
    } else {
        // AI 万一忘了占位符，仍然保证老师内容不会丢
        result += `\n${lockedWordText}`;
    }
} else {
    result = result.replaceAll('[[WORD_ERRORS]]', '');
}


// 插入老师原始填写的短语 / 句子问题
if (lockedPhraseText) {
    if (result.includes('[[PHRASE_ERRORS]]')) {
        result = result.replace(
            '[[PHRASE_ERRORS]]',
            lockedPhraseText
        );

        result = result.replaceAll('[[PHRASE_ERRORS]]', '');
    } else {
        // AI 万一忘了占位符，仍然保证老师内容不会丢
        result += `\n${lockedPhraseText}`;
    }
} else {
    result = result.replaceAll('[[PHRASE_ERRORS]]', '');
}


res.status(200).json({ result });

    } catch (error) {
    // 真实错误只记录在 Vercel 后台
    console.error('生成出错（后台记录）:', {
        status: error?.status,
        message: error?.message,
        stack: error?.stack
    });

    const status = Number(error?.status);

    // 这些通常属于临时繁忙、超时或网络波动
    const temporaryStatuses = [429, 500, 502, 503, 504];

    if (temporaryStatuses.includes(status)) {
        return res.status(503).json({
            error: 'AI 服务暂时繁忙，系统已经自动重试 3 次，请稍后再试。'
        });
    }

    // 余额、API Key、模型参数等其他问题
    // 前台不显示具体原因
    return res.status(500).json({
        error: '生成错误'
    });
}
}
