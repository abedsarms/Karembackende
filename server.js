const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('KAReM Backend Server is Running! 🚀');
});

app.post('/api/watch-ad', (req, res) => {
    const { userId } = req.body;
    res.json({
        success: true,
        message: "پاداش با موفقیت ثبت شد",
        reward: 5
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
