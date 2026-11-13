# 模型资产说明

## 来源

本目录的模型来自 **HanLP 2.x 的 CTB 词性标注模型**
`CTB9_POS_ELECTRA_SMALL`（ELECTRA-small，12.3M 参数），
权重经导出 + fp16 转换得到，**推理结果与 HanLP 原版逐句一致**（64/64 验证）。

| 文件 | 大小 | 说明 |
|---|---|---|
| `model.onnx` | 26 MB | fp16 单文件 ONNX（无 external data） |
| `vocab.txt` | 110 KB | ElectraTokenizer 词表（21128 项） |
| `labels.json` | 228 B | 37 个 CTB 词性标签 |
| `ort-wasm-simd-threaded.wasm` | 15 MB | ONNX Runtime WASM 后端 |
| `ort-wasm-simd-threaded.mjs` | 24 KB | WASM 胶水层 |

> `ort-wasm-*` 两个文件是从 `onnxruntime-web` 的 `dist/` 复制出来的。
> 这样运行时可以固定 `wasmPaths` 指向本目录，**避免 onnxruntime 去 CDN
> 或 node_modules 深处找 wasm**，保证离线可用、路径可控。

## 标签映射

CTB 词性集里「的地得」有专属标签：

| 标签 | 全称 | 含义 | 应写 |
|---|---|---|---|
| `DEV` | manner `de`, `de` before VP | 状语标记（X-地-VP） | **地** |
| `DER` | resultative `de`, V-de-R | 结果/程度补语 | **得** |
| `DEG` | genitive `de` | 属格/定语标记 | **的** |
| `DEC` | complementizer `de` | 名词化标记 | **的** |
| `SP` | sentence final particle | 句末语气词 | **的** |

## 为什么不分词

模型输入是**逐字**的（每个汉字一个 token），不经过分词器。

原因：实测 jieba 等分词器会把 `跑得快`、`说得对`、`做得好`、`来得太突然`
切成一个整词，导致里面的「得」**根本不会进入标注**，直接漏检。
51 句里有 10 句出现这种「吞字」，且集中打击 `V得C` 补语结构。

逐字输入的词性判断与「先分词再标注」的结果**完全一致**，因为模型看的是
上下文语法结构，不依赖词边界。

## 如何重新生成

需要 Python 环境 + `torch` + `transformers` + `onnx` + `onnxconverter-common`：

```python
import torch, torch.nn as nn, glob
from transformers import ElectraModel, ElectraConfig
from onnxconverter_common import float16
import onnx

posd = '~/.hanlp/pos/pos_ctb_electra_small_20220215_111944'
tdir = glob.glob('~/.hanlp/transformers/electra_zh_small_*/')[0]

sd = torch.load(posd + '/model.pt', map_location='cpu', weights_only=False)
if isinstance(sd, dict) and 'state_dict' in sd:
    sd = sd['state_dict']

# 剥掉 HanLP 的 encoder.transformer. 前缀，映射到 HF ElectraModel
enc = {k[len('encoder.transformer.'):]: v
       for k, v in sd.items() if k.startswith('encoder.transformer.')}
W, b = sd['classifier.weight'], sd['classifier.bias']

class M(nn.Module):
    def __init__(self):
        super().__init__()
        self.e = ElectraModel(ElectraConfig.from_pretrained(tdir))
        self.lin = nn.Linear(W.shape[1], W.shape[0])
    def forward(self, i, a, t):
        return self.lin(self.e(input_ids=i, attention_mask=a,
                               token_type_ids=t).last_hidden_state)

m = M()
m.e.load_state_dict(enc, strict=True)
m.lin.weight.data = W
m.lin.bias.data = b
m.eval()

d = (torch.zeros(1, 8, dtype=torch.long),
     torch.ones(1, 8, dtype=torch.long),
     torch.zeros(1, 8, dtype=torch.long))

torch.onnx.export(
    m, d, 'pos.onnx',
    input_names=['input_ids', 'attention_mask', 'token_type_ids'],
    output_names=['logits'],
    dynamic_axes={'input_ids': {0: 'b', 1: 's'},
                  'attention_mask': {0: 'b', 1: 's'},
                  'token_type_ids': {0: 'b', 1: 's'},
                  'logits': {0: 'b', 1: 's'}},
    opset_version=14,
    external_data=False,   # 关键：必须单文件
)

# fp16 压缩（精度无损，50MB → 26MB）
m16 = float16.convert_float_to_float16(onnx.load('pos.onnx'), keep_io_types=True)
onnx.save(m16, 'model.onnx')
```

`labels.json` 来自 `posd/vocabs.json` 的 `tag.idx_to_token`。
`vocab.txt` 来自 `tdir/vocab.txt`。

## 为什么用 fp16 而不是 int8

int8 量化后 13.7MB，但实测 26 句里有 **3 句判定变化**，其中
`目的地` 的「的」会被判成 `DEG`（虽然 FROZEN_WORDS 能兜住，但不保险）。
fp16 是 **0 差异**，所以选 fp16。

## License

模型权重继承 HanLP 的 **Apache-2.0**；底层预训练模型为
`hfl/chinese-electra-180g-small-discriminator`（Apache-2.0）。
