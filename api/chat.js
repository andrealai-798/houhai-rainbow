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

【格式要求】：
1. 回复直接以学生英文名切入，不要输出“家长您好”“请查收”“以下是反馈”等开头。
2. 反馈尽量控制在150字以内；如果知识点较多，优先保证知识点和练习建议完整。
3. 老师提供的具体单词、短语、句子使用中文全角方括号【】标注。
4.  [[WORD_ERRORS]] 和 [[PHRASE_ERRORS]] 是程序专用占位符，不属于反馈文字。必须逐字符原样保留，不能改成【WORD_ERRORS】、【PHRASE_ERRORS】或任何其他形式，也不能在占位符外额外添加【】、引号或括号。
5. 正文以1-2段为主，不要分成很多小段。

【知识点使用规则】：
- [[WORD_ERRORS]] 代表老师标注的单词发音问题。
- [[PHRASE_ERRORS]] 代表老师标注的短语、句子、语法或其他结构问题。
请把存在的知识点自然融入反馈：
单词问题归入发音方面；短语、句子、语法问题根据老师给出的内容，自然归入语法结构、漏读或表达等相应方面。
你可以自由添加自然的连接语和反馈语言，但不要重复解释同一个知识点。
不要机械使用“单词问题”“短语问题”等标签，也不要套固定句型。

【知识点与后续文字的衔接】：
[[WORD_ERRORS]] 和 [[PHRASE_ERRORS]] 所代表的老师知识点是不可拆分的完整信息片段。
知识点与后续解释、另一类问题或练习建议之间必须使用合适的中文标点自然衔接，绝不能把老师知识点的最后一个字与后面的文字直接连在一起。
同一类多个知识点可以使用顿号、逗号或分号自然连接；从一类问题转入另一类问题，或从具体问题转入练习建议时，要使用清楚、完整的标点进行分隔。

【反馈顺序】：
先肯定本次整体表现和亮点，再自然反馈发音问题及短语/句子/语法问题。
所有具体问题反馈完成后，再按照下方【针对性练习建议】给出与问题类型对应的练习；最后用1-2句简短、自然的鼓励或期待收尾。
整体要自然衔接，不要为了遵守顺序而写成机械模板。

【语言要求】：
1. 像真实老师给家长写微信反馈一样，自然、亲切、口语化，可以活泼生动并适当使用Emoji。
2. 表达可以有变化，但自然优先，不要为了追求新奇而使用夸张、网络化或突兀的说法，如“抠一抠”“焊在嘴巴里”等。
3. 不使用比喻式、过度夸张的评价。
4. 不要自行创造【出现问题的单词】【这些单词】【错误单词】等概括性方括号内容。
5. 相邻反馈可以变化开头、句式和夸奖角度，但不要求每次完全不同。

【内容基调要求】：
1. 遵循肯定亮点 + 温和建议 + 期待升华。
2. 根据作业等级调整语气：完美作业要自豪，错误适中要温和引导，攻坚挑战要共情打气。
3. 绝对不要用中文音译来纠音，只需要点出读错的单词即可。
4. 【针对性练习建议】：
- 所有具体问题反馈完成后，再统一给出练习建议，并放在最后1-2句鼓励之前。
- 如果有单词发音问题，练习建议必须是一句语法完整、对象明确的话，并完整包含以下4个信息：
  ① 跟着示范音频；
  ② 练习以上/相关单词；
  ③ 每个单词读5遍；
  ④ 巩固正确读音。
  不能省略“单词”这个练习对象，不能出现“跟着示范音频把读5遍”这类缺少宾语的表达。
- 如果有短语、句子或语法结构问题，练习建议必须是一句语法完整、对象明确的话，并完整包含以下3个信息：
  ① 将以上/对应的语法点、短语或句子回归原句；
  ② 读3遍；
  ③ 加深对结构或用法的理解。
  不能省略“语法点、短语或句子”这个练习对象，不能出现“把回归原句读3遍”这类缺少宾语的表达。
- 如果两类问题同时存在，两项练习必须全部出现，可以自然合并成一句或写成前后衔接的两句，但两项练习的对象、动作和次数都必须完整。
- 如果只有其中一类问题，只给出对应的练习建议。
- 次数统一写作“5遍”“3遍”，不要写成“五遍”“三遍”。
- 练习建议的完整性优先于150字限制。不能为了缩短反馈而省略练习对象、动作或次数。
5. 【结尾鼓励】：
练习建议之后，只保留1-2句简短、自然的鼓励或期待作为结尾。不要再次总结前面的表现，不要重复知识点或练习建议，也不要连续写多句内容很接近的鼓励。
结尾可以活泼、有亲和力，但要简洁收住。
`;
        const wordReference = wordItems.length
    ? wordItems.map(i => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        return reason
            ? `- ${text}｜老师标注：${reason}`
            : `- ${text}｜老师只要求注意发音`;
    }).join('\n')
    : '无';

const phraseReference = phraseItems.length
    ? phraseItems.map(i => {
        const text = String(i.text || '').trim();
        const reason = String(i.reason || '').trim();

        return `- ${text}｜老师标注：${reason}`;
    }).join('\n')
    : '无';
        
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
老师知识点参考（仅用于理解老师指出的问题，不得自行增加、猜测或改写新的问题）：

【单词参考】
${wordReference}

【短语/句子参考】
${phraseReference}

最终反馈中需要使用的锁定内容：
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
