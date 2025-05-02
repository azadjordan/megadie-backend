import jwt from 'jsonwebtoken'

const generateToken = (res, userId)=>{
    const token = jwt.sign({ userId: userId}, process.env.JWT_SECRET, { expiresIn: '30d'})

        // Set JWT as JTTP-Only cookie
        res.cookie('jwt', token, {
            httpOnly: true,
            secure: false, // when we have https it should be true
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        })
}

export default generateToken